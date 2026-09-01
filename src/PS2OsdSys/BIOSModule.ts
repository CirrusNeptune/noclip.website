import {mat4} from "gl-matrix";
import {assert, assertExists} from "../util";
import {clamp} from "../MathHelpers";
import IBIOSScene from "./IBIOSScene";

const STABLE_TICK_RATE = 1.0 / 60.0;

export interface StableStateOps<StableStateType> {
    makeStableState: () => StableStateType,
    copyStableState: (to: StableStateType, from: StableStateType) => void,
    interpolateStableState: (out: StableStateType, a: StableStateType, b: StableStateType, alpha: number) => void
}

export abstract class BIOSModule<StableStateType> {
    protected tickStableState: StableStateType;
    protected prevStableState: StableStateType;
    protected drawStableState: StableStateType;
    private lastStableTickTime: number | null = null;

    public tick(time: number) {
        if (this.lastStableTickTime === null) {
            this.stableTick();
            this.stableStateOps.copyStableState(this.prevStableState, this.tickStableState);
            this.stableStateOps.copyStableState(this.drawStableState, this.prevStableState);
            this.lastStableTickTime = time;
            return;
        }
        while (this.lastStableTickTime < time) {
            this.stableStateOps.copyStableState(this.prevStableState, this.tickStableState);
            this.stableTick();
            this.lastStableTickTime += STABLE_TICK_RATE;
        }
        this.interpolateDrawStableState(time);
    }

    private interpolateDrawStableState(time: number) {
        const lastStableTickTime = assertExists(this.lastStableTickTime);
        assert(time <= lastStableTickTime);

        const prevStableTickTime = lastStableTickTime - STABLE_TICK_RATE;
        const alpha = clamp((time - prevStableTickTime) / STABLE_TICK_RATE, 0.0, 1.0);

        this.stableStateOps.interpolateStableState(this.drawStableState, this.prevStableState, this.tickStableState, alpha);
    }

    /**
     * The BIOS opening animation makes heavy use of third-order differentials
     * and state transitions which assume a fixed update cadence. Since noclip
     * cannot guarantee this, stableTick is called in a sub-ticking loop which
     * simulates a stable ticking at 60Hz.
     *
     * Make all stable state accesses through this.tickStableState.
     */
    protected abstract stableTick(): void;

    /**
     * In the original, tick and draw were performed in the same call flow.
     * In noclip it's split into paired tick/draw functions. The previous
     * stable state is kept so the actual draw can present a linear
     * interpolation between two states and unlock the overall presentation
     * from 60Hz without disrupting the original behavior.
     *
     * Make all stable state accesses through this.drawStableState.
     */
    public abstract draw(): void;

    public abstract updateCameraMatrix(cameraMatrix: mat4, roll: boolean): void;

    protected constructor(protected biosScene: IBIOSScene, private stableStateOps: StableStateOps<StableStateType>) {
        this.tickStableState = stableStateOps.makeStableState();
        this.prevStableState = stableStateOps.makeStableState();
        this.drawStableState = stableStateOps.makeStableState();
    }
}
