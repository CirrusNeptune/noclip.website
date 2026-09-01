import {BIOSModule, StableStateOps} from "./BIOSModule";
import {lerp} from "../MathHelpers";
import IBIOSScene from "./IBIOSScene";
import {mat4} from "gl-matrix";

/**
 * Any animated variables directly used in drawing should be kept here
 * and linear interpolated with the previous to resolve the stable tick results
 */
interface StableState {
    frameCounter: number,
}

const STABLE_STATE_OPS: StableStateOps<StableState> = {
    makeStableState: () => {
        return {
            frameCounter: 0,
        };
    },

    copyStableState: (to: StableState, from: StableState) => {
        to.frameCounter = from.frameCounter;
    },

    interpolateStableState: (out: StableState, a: StableState, b: StableState, alpha: number) => {
        out.frameCounter = lerp(a.frameCounter, b.frameCounter, alpha);
    }
};

export class ClockModule extends BIOSModule<StableState> {
    private frameCounter: number = 0;

    protected stableTick() {
        this.tickStableState.frameCounter = this.frameCounter;

        this.frameCounter += 1;
    }

    public draw() {

    }

    public updateCameraMatrix(cameraMatrix: mat4, roll: boolean) {

    }

    constructor(biosScene: IBIOSScene) {
        super(biosScene, STABLE_STATE_OPS);
    }
}
