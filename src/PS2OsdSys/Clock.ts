import {BIOSModule, DrawParams, StableStateOps} from "./BIOSModule";
import {lerp, Mat4Identity, MathConstants, Vec3Zero} from "../MathHelpers";
import IBIOSScene from "./IBIOSScene";
import {mat4, ReadonlyMat4, ReadonlyVec2, ReadonlyVec3, vec2, vec3, vec4} from "gl-matrix";
import {GfxRenderInstList} from "../gfx/render/GfxRenderInstManager";
import {assert, nArray} from "../util";
import {GfxrAttachmentSlot} from "../gfx/render/GfxRenderGraph";

const scratchVec: vec3 = vec3.create();
const scratchMtx: mat4 = mat4.create();

const NUM_CRYSTALS = 12;
const NUM_ORBS = 7;

function cyclicUInt16LPF(current: number, target: number, coef: number): number {
    // Temporarily make signed for seamless interpolation at unsigned overflow.
    return ((current << 16 >> 16) + ((target - current) << 16 >> 16) * coef) << 16 >>> 16;
}

function cyclicUInt16Lerp(a: number, b: number, t: number): number {
    if (Math.abs(b - a) <= 0x7fff)
        return lerp(a, b, t);
    if (a < b)
        return lerp(a + 0xffff, b, t);
    return lerp(a, b + 0xffff, t);
}

interface ClockCrystalStableState {
    crystalLengthScale: number;
    crystalFillInterp: number;
    refractionRGBA: vec4;
    flowRGBA: vec4;
}

function makeClockCrystalStableState(): ClockCrystalStableState {
    return {
        crystalLengthScale: 0,
        crystalFillInterp: 0,
        refractionRGBA: vec4.create(),
        flowRGBA: vec4.create(),
    }
}

function copyClockCrystalStableState(to: ClockCrystalStableState, from: ClockCrystalStableState) {
    to.crystalLengthScale = from.crystalLengthScale;
    to.crystalFillInterp = from.crystalFillInterp;
    vec4.copy(to.refractionRGBA, from.refractionRGBA);
    vec4.copy(to.flowRGBA, from.flowRGBA);
}

function interpolateClockCrystalStableState(out: ClockCrystalStableState, a: ClockCrystalStableState, b: ClockCrystalStableState, alpha: number) {
    out.crystalLengthScale = lerp(a.crystalLengthScale, b.crystalLengthScale, alpha);
    out.crystalFillInterp = lerp(a.crystalFillInterp, b.crystalFillInterp, alpha);
    vec4.lerp(out.refractionRGBA, a.refractionRGBA, b.refractionRGBA, alpha);
    vec4.lerp(out.flowRGBA, a.flowRGBA, b.flowRGBA, alpha);
}

/**
 * Any animated variables directly used in drawing should be kept here
 * and linear interpolated with the previous to resolve the stable tick results
 */
interface StableState {
    frameCounter: number;
    bgColorBias: vec3;
    bgScrollAnim: number;
    crystalStates: ClockCrystalStableState[];
    mainCrystalRefractionRGBA: vec4;
    mainCrystalReflectionRGBA: vec4;
    activeHourIdx: number;
    minuteRotationUint16: number;
    topHourBaseRotationUint16: number;
}

const STABLE_STATE_OPS: StableStateOps<StableState> = {
    makeStableState: () => {
        return {
            frameCounter: 0,
            bgColorBias: vec3.create(),
            bgScrollAnim: 0,
            crystalStates: nArray(NUM_CRYSTALS, makeClockCrystalStableState),
            mainCrystalRefractionRGBA: vec4.create(),
            mainCrystalReflectionRGBA: vec4.create(),
            activeHourIdx: 0,
            minuteRotationUint16: 0,
            topHourBaseRotationUint16: 0,
        };
    },

    copyStableState: (to: StableState, from: StableState) => {
        to.frameCounter = from.frameCounter;
        vec3.copy(to.bgColorBias, from.bgColorBias);
        to.bgScrollAnim = from.bgScrollAnim;
        for (let i = 0; i < NUM_CRYSTALS; ++i)
            copyClockCrystalStableState(to.crystalStates[i], from.crystalStates[i]);
        vec4.copy(to.mainCrystalRefractionRGBA, from.mainCrystalRefractionRGBA);
        vec4.copy(to.mainCrystalReflectionRGBA, from.mainCrystalReflectionRGBA);
        to.activeHourIdx = from.activeHourIdx;
        to.minuteRotationUint16 = from.minuteRotationUint16;
        to.topHourBaseRotationUint16 = from.topHourBaseRotationUint16;
    },

    interpolateStableState: (out: StableState, a: StableState, b: StableState, alpha: number) => {
        out.frameCounter = lerp(a.frameCounter, b.frameCounter, alpha);
        vec3.lerp(out.bgColorBias, a.bgColorBias, b.bgColorBias, alpha);
        out.bgScrollAnim = lerp(a.bgScrollAnim, b.bgScrollAnim, alpha);
        for (let i = 0; i < NUM_CRYSTALS; ++i)
            interpolateClockCrystalStableState(out.crystalStates[i], a.crystalStates[i], b.crystalStates[i], alpha);
        vec4.lerp(out.mainCrystalRefractionRGBA, a.mainCrystalRefractionRGBA, b.mainCrystalRefractionRGBA, alpha);
        vec4.lerp(out.mainCrystalReflectionRGBA, a.mainCrystalReflectionRGBA, b.mainCrystalReflectionRGBA, alpha);
        out.activeHourIdx = a.activeHourIdx;
        out.minuteRotationUint16 = cyclicUInt16Lerp(a.minuteRotationUint16, b.minuteRotationUint16, alpha);
        out.topHourBaseRotationUint16 = cyclicUInt16Lerp(a.topHourBaseRotationUint16, b.topHourBaseRotationUint16, alpha);
    }
};

enum LerpState {
    DoneDecreasing,
    Increasing,
    DoneIncreasing,
    Decreasing
}

class LerpController {
    private currentTicks: number = 0;
    private atEndpoint: boolean = false;
    private state: LerpState = LerpState.DoneDecreasing;
    constructor(private durationTicks: number = 0) {
    }

    public getDurationTicks(): number {
        return this.durationTicks;
    }

    public getCurrentTicks(): number {
        return this.currentTicks;
    }

    public lerpValue(value: number): number {
        assert(this.durationTicks !== 0);
        return this.currentTicks * value / this.durationTicks >> 0;
    }

    public isInState(state: LerpState): boolean {
        return state === this.state;
    }

    public isAtEndpoint(): boolean {
        return this.atEndpoint;
    }

    public reset() {
        this.state = LerpState.DoneDecreasing;
        this.currentTicks = 0;
        this.atEndpoint = false;
    }

    public conditionallyStartIncreasing() {
        if (this.state === LerpState.DoneDecreasing) {
            this.currentTicks = 0;
            this.state = LerpState.Increasing;
            this.atEndpoint = true;
        }
    }

    public conditionallyStartDecreasing() {
        if (this.state === LerpState.DoneIncreasing) {
            this.currentTicks = this.durationTicks;
            this.state = LerpState.Decreasing;
            this.atEndpoint = true;
        }
    }

    public tick() {
        this.atEndpoint = false;
        if (this.state === LerpState.Increasing) {
            this.currentTicks += 1;
            if (this.currentTicks === this.durationTicks) {
                this.atEndpoint = true;
                this.state = LerpState.DoneIncreasing;
            }
        } else if (this.state === LerpState.Decreasing) {
            this.currentTicks -= 1;
            if (this.currentTicks === 0) {
                this.atEndpoint = true;
                this.state = LerpState.DoneDecreasing;
            }
        }
    }
}

enum OrbInterpState {
    Idle,
    Increasing,
    IncreasingWithTrigger,
    Decreasing,
    Four
}

function incrementallySeekRGBAToTarget(rgba: vec4, target: vec4, delta: number): boolean {
    let changed = false;
    for (let i = 0; i < 4; ++i) {
        if (rgba[i] !== target[i]) {
            if (rgba[i] < target[i])
                rgba[i] += delta;
            else
                rgba[i] -= delta;
            changed = true;
        }
    }
    return !changed;
}

const HOUR_REFRACTION_COLOR_TABLE: vec4[] = [
    [0x2D, 0x55, 0x66, 0x80],
    [0x44, 0x2F, 0x66, 0x80],
    [0x2C, 0x47, 0x60, 0x80],
    [0x33, 0x49, 0x6F, 0x80],
    [0x33, 0x6F, 0x71, 0x80],
];

const MAIN_REFRACTION_COLOR_TABLE: vec4[] = [
    [0xCA, 0xF6, 0xE7, 0x80],
    [0xBB, 0xEB, 0xFF, 0x80],
];

interface BaseRenderBlock {
    texScrollStep: number;
    //numQuads: number;
    //posPerVertRef: ReadonlyVec3[];
    //normPerQuadRef: ReadonlyVec3[];
    //stPerVertRef: ReadonlyVec2[];
    objMtx: mat4;
    //projMtxRef: ReadonlyMat4;
    //camMtxRef: ReadonlyMat4;
}

function makeBaseRenderBlock(): BaseRenderBlock {
    return {
        texScrollStep: 0,
        //numQuads: 0,
        //posPerVertRef: [],
        //normPerQuadRef: [],
        //stPerVertRef: [],
        objMtx: mat4.create(),
        //projMtxRef: Mat4Identity,
        //camMtxRef: Mat4Identity,
    };
}

function copyBaseRenderBlock(to: BaseRenderBlock, from: BaseRenderBlock) {
    to.texScrollStep = from.texScrollStep;
    //to.numQuads = from.numQuads;
    //to.posPerVertRef = from.posPerVertRef;
    //to.normPerQuadRef = from.normPerQuadRef;
    //to.stPerVertRef = from.stPerVertRef;
    mat4.copy(to.objMtx, from.objMtx);
    //to.projMtxRef = from.projMtxRef;
    //to.camMtxRef = from.camMtxRef;
}

interface CrystalRenderBlock extends BaseRenderBlock {
    objScale: vec3;
    refractionRGBA: vec4;
    viewDotScale: number;
    refractBumpRGBA: vec4;
    stScroll: vec2;
    refraction: number;
    flowRGBA: vec4;
    bumpRGBA: vec4;
}

function makeCrystalRenderBlock(): CrystalRenderBlock {
    return {
        ...makeBaseRenderBlock(),
        objScale: vec3.create(),
        refractionRGBA: vec4.create(),
        viewDotScale: 0,
        refractBumpRGBA: vec4.create(),
        stScroll: vec2.create(),
        refraction: 0,
        flowRGBA: vec4.create(),
        bumpRGBA: vec4.create()
    };
}

function copyCrystalRenderBlock(to: CrystalRenderBlock, from: CrystalRenderBlock) {
    copyBaseRenderBlock(to, from);
    vec3.copy(to.objScale, from.objScale);
    vec4.copy(to.refractionRGBA, from.refractionRGBA);
    to.viewDotScale = from.viewDotScale;
    vec4.copy(to.refractBumpRGBA, from.refractBumpRGBA);
    vec2.copy(to.stScroll, from.stScroll);
    to.refraction = from.refraction;
    vec4.copy(to.flowRGBA, from.flowRGBA);
    vec4.copy(to.bumpRGBA, from.bumpRGBA);
}

abstract class BaseRenderObject {
    protected zOffset: number = 0;
    public getZOffset(): number { return this.zOffset; }
}

class OrbRenderObject extends BaseRenderObject {
    block: BaseRenderBlock = makeBaseRenderBlock();
    orbIdx: number = -1;
}

class CrystalRenderObject extends BaseRenderObject {
    block: CrystalRenderBlock = makeCrystalRenderBlock();
    scaleInterp: number = 0;
    refractionRgba: vec4 = vec4.create();
    viewDotScale: number = 0;
    reflectionRgba: vec4 = vec4.create();

    public setCrystal(scaleInterp: number, template: CrystalRenderBlock, viewMatrix: mat4,
                      refractionRgba: vec4, viewDotScale: number, reflectionRgba: vec4) {
        vec3.transformMat4(scratchVec, Vec3Zero, template.objMtx);
        scratchVec[0] = -scratchVec[0];
        vec3.transformMat4(scratchVec, scratchVec, viewMatrix);
        this.zOffset = scratchVec[2];
        copyCrystalRenderBlock(this.block, template);
        this.viewDotScale = viewDotScale;
        this.scaleInterp = scaleInterp;
        vec4.copy(this.refractionRgba, refractionRgba);
        vec4.copy(this.reflectionRgba, reflectionRgba);
    }
}

const CRYSTAL_Y_TRANSLATE: vec3 = [0, 20, 0];

export class ClockModule extends BIOSModule<StableState> {
    private instLists: GfxRenderInstList[] = [];
    private curInstListIdx: number = -1;

    private resetInstLists() {
        this.curInstListIdx = -1;
    }

    private startInstList(): GfxRenderInstList {
        this.curInstListIdx += 1;
        if (this.instLists[this.curInstListIdx] === undefined)
            this.instLists[this.curInstListIdx] = new GfxRenderInstList();
        this.instLists[this.curInstListIdx].reset();
        return this.instLists[this.curInstListIdx];
    }

    private getCurInstList(): GfxRenderInstList {
        return this.instLists[this.curInstListIdx];
    }

    private frameCounter: number = 0;
    private eyeDirection: vec3 = vec3.create();
    private eyeUpDirection: vec3 = vec3.create();
    private cameraPosition: vec3 = vec3.create();

    private orbInterpState: OrbInterpState = OrbInterpState.Idle;

    private bgColorBiasLerp: LerpController = new LerpController(40);

    private tickBG() {
        this.bgColorBiasLerp.tick();
        if (!this.bgColorBiasLerp.isInState(LerpState.DoneDecreasing)) {
            this.tickStableState.bgColorBias[0] = this.bgColorBiasLerp.lerpValue(40);
            this.tickStableState.bgColorBias[1] = this.tickStableState.bgColorBias[0];
            this.tickStableState.bgColorBias[2] = this.tickStableState.bgColorBias[0];
        }
        this.tickStableState.bgScrollAnim += 1;
    }

    private drawBG() {
        this.biosScene.clockBGGeometry.draw(this.biosScene, this.getCurInstList(),
            this.drawStableState.bgColorBias, this.drawStableState.bgScrollAnim);
    }

    private incrementClockCrystalColors(inactiveHourRefractionRGBA: vec4,
                                        mainRefractionRGBA: vec4,
                                        activeHourReflectionRGBA: vec4,
                                        inactiveHourFlowRGBA: vec4,
                                        mainReflectionRGBA: vec4,
                                        activeHourFlowRGBA: vec4) {
        for (let i = 0; i < NUM_CRYSTALS; ++i) {
            if (i === this.tickStableState.activeHourIdx) {
                incrementallySeekRGBAToTarget(this.tickStableState.crystalStates[i].refractionRGBA, activeHourReflectionRGBA, 1);
                incrementallySeekRGBAToTarget(this.tickStableState.crystalStates[i].flowRGBA, activeHourFlowRGBA, 1);
            } else {
                incrementallySeekRGBAToTarget(this.tickStableState.crystalStates[i].refractionRGBA, inactiveHourRefractionRGBA, 1);
                incrementallySeekRGBAToTarget(this.tickStableState.crystalStates[i].flowRGBA, inactiveHourFlowRGBA, 1);
            }
        }
        incrementallySeekRGBAToTarget(this.tickStableState.mainCrystalRefractionRGBA, mainRefractionRGBA, 1);
        incrementallySeekRGBAToTarget(this.tickStableState.mainCrystalReflectionRGBA, mainReflectionRGBA, 1);
    }

    private nextHourRefractionColor8FrameCounter: number = 0;
    private nextHourRefractionColorCur: number = 0;
    private getNextHourRefractionColor(out: vec4) {
        if (this.nextHourRefractionColor8FrameCounter++ >= 8) {
            this.nextHourRefractionColor8FrameCounter = 0;
            if (incrementallySeekRGBAToTarget(out, HOUR_REFRACTION_COLOR_TABLE[this.nextHourRefractionColorCur], 1)) {
                this.nextHourRefractionColorCur = (this.nextHourRefractionColorCur + 1) % HOUR_REFRACTION_COLOR_TABLE.length;
            }
        }
    }

    private nextMainRefractionColor8FrameCounter: number = 0;
    private nextMainRefractionColorCur: number = 0;
    private getMainRefractionColor(out: vec4) {
        if (this.nextMainRefractionColor8FrameCounter++ >= 8) {
            this.nextMainRefractionColor8FrameCounter = 0;
            if (incrementallySeekRGBAToTarget(out, MAIN_REFRACTION_COLOR_TABLE[this.nextMainRefractionColorCur], 1)) {
                this.nextMainRefractionColorCur = (this.nextMainRefractionColorCur + 1) % MAIN_REFRACTION_COLOR_TABLE.length;
            }
        }
    }

    private inactiveHourRefractionRGBA: vec4 = [0x2D, 0x55, 0x66, 0x80];
    private activeHourRefractionRGBA: vec4 = [0x0, 0x0, 0x0, 0x0];
    private mainRefractionRGBA: vec4 = [0x0, 0x0, 0x0, 0x0];
    private inactiveHourFlowRGBA: vec4 = [0x3C, 0x3C, 0x3C, 0x80];
    private mainReflectionRGBA: vec4 = [0x3C, 0x3C, 0x3C, 0x80];
    private activeHourFlowRGBA: vec4 = [0x80, 0x80, 0x80, 0x1E];
    private tickClockCrystalColors() {
        this.getNextHourRefractionColor(this.inactiveHourRefractionRGBA);
        vec4.copy(this.activeHourRefractionRGBA, this.inactiveHourRefractionRGBA);
        vec4.set(this.mainRefractionRGBA, 0xA7, 0xD9, 0xFF, 0x0);
        this.getMainRefractionColor(this.mainRefractionRGBA);
        for (let i = 0; i < 3; ++i) {
            this.activeHourRefractionRGBA[i] = this.mainRefractionRGBA[i] + (this.inactiveHourRefractionRGBA[i] >>> 1);
        }
        this.incrementClockCrystalColors(this.inactiveHourRefractionRGBA, this.mainRefractionRGBA,
            this.activeHourRefractionRGBA, this.inactiveHourFlowRGBA, this.mainReflectionRGBA, this.activeHourFlowRGBA);
    }

    private getCurrentSecondsFloat(): number {
        return this.currentSeconds + this.currentMilliseconds / 1000.0;
    }

    private getCurrentMinutesFloat(): number {
        return this.currentMinutes + this.getCurrentSecondsFloat() / 60.0;
    }

    private getCurrentHoursFloat(): number {
        return this.currentHours + this.getCurrentMinutesFloat() / 60.0;
    }

    private minuteProgressUint16: number = 0;
    private twelveHourProgressUint16: number = 0;
    private remainingHourFraction: number = 0;
    private remainingHourFraction_2: number = 0;
    private tickClockProgressValues() {
        this.tickStableState.activeHourIdx = (this.getCurrentHoursFloat() >>> 0) % NUM_CRYSTALS;

        const topHourBaseRotationTarget = ((this.tickStableState.activeHourIdx << 16) / NUM_CRYSTALS) >>> 0;
        if (Math.abs(this.tickStableState.minuteRotationUint16) <= 200)
            this.tickStableState.topHourBaseRotationUint16 = topHourBaseRotationTarget;
        else
            this.tickStableState.topHourBaseRotationUint16 = cyclicUInt16LPF(this.tickStableState.topHourBaseRotationUint16, topHourBaseRotationTarget, 0.1);

        const minuteRotationTarget = (this.getCurrentSecondsFloat() * 65536.0 / 60.0) >>> 0;
        this.tickStableState.minuteRotationUint16 = cyclicUInt16LPF(this.tickStableState.minuteRotationUint16, minuteRotationTarget, 0.1);

        const twelveHourProgressTarget = (this.getCurrentHoursFloat() * 65536.0 / 12.0) >>> 0;
        this.twelveHourProgressUint16 += ((twelveHourProgressTarget - this.twelveHourProgressUint16) * 0.1) >> 0;

        const minuteProgressTarget = (this.getCurrentSecondsFloat() * 65536.0 / 60.0) >>> 0;
        this.minuteProgressUint16 = cyclicUInt16LPF(this.minuteProgressUint16, minuteProgressTarget, 0.1);

        this.remainingHourFraction = 1.0 - this.getCurrentMinutesFloat() / 60.0;
        this.remainingHourFraction_2 = this.remainingHourFraction;
    }

    private initClockProgressValues() {
        this.tickStableState.activeHourIdx = (this.getCurrentHoursFloat() >>> 0) % NUM_CRYSTALS;
        this.twelveHourProgressUint16 = (this.getCurrentHoursFloat() * 65536.0 / 12.0) >>> 0;
        this.minuteProgressUint16 = (this.getCurrentSecondsFloat() * 65536.0 / 60.0) >>> 0;
        this.tickStableState.topHourBaseRotationUint16 = ((this.tickStableState.activeHourIdx << 16) / NUM_CRYSTALS) >>> 0;
        this.tickStableState.minuteRotationUint16 = (this.getCurrentSecondsFloat() * 65536.0 / 60.0) >>> 0;
    }

    private tickClockProgressInternal() {
        this.tickClockProgressValues();
        this.tickClockCrystalColors();
    }

    private crystalLengthScaleLerp: LerpController = new LerpController(1);
    private tickClockProgress() {
        this.crystalLengthScaleLerp.tick();
        this.tickClockProgressInternal();
        for (let i = 0; i < NUM_CRYSTALS; ++i) {
            const crystalState = this.tickStableState.crystalStates[i];
            if (i === this.tickStableState.activeHourIdx) {
                if (this.remainingHourFraction < crystalState.crystalFillInterp)
                    crystalState.crystalFillInterp = this.remainingHourFraction;
                else
                    crystalState.crystalFillInterp = Math.min(this.remainingHourFraction, crystalState.crystalFillInterp + 0.004);
            } else {
                crystalState.crystalFillInterp = 0;
            }
            crystalState.crystalLengthScale = this.crystalLengthScaleLerp.lerpValue(128) / 128;
        }
    }

    private initClockProgress() {
        // TODO: Make these symbolic constants?
        vec4.set(this.mainRefractionRGBA, 0x80, 0x80, 0x80, 0x80);
        vec4.set(this.mainReflectionRGBA, 0x80, 0x80, 0x80, 0x80);
        this.initClockProgressValues();
        this.tickClockProgressInternal();
        for (let i = 0; i < NUM_CRYSTALS; ++i) {
            this.tickStableState.crystalStates[(i + this.tickStableState.activeHourIdx) % NUM_CRYSTALS].crystalLengthScale = 0;
            this.tickStableState.crystalStates[i].crystalFillInterp = 0;
            if (i === this.tickStableState.activeHourIdx) {
                vec4.set(this.tickStableState.crystalStates[i].refractionRGBA, 0x80, 0x80, 0x80, 0x80);
            } else {
                vec4.set(this.tickStableState.crystalStates[i].refractionRGBA, 0x80, 0x80, 0x80, 0x80);
            }
        }
    }

    private conditionallyStartCrystalGrow() {
        if (this.crystalLengthScaleLerp.isInState(LerpState.DoneDecreasing)) {
            this.crystalLengthScaleLerp.reset();
            this.crystalLengthScaleLerp.conditionallyStartIncreasing();
            for (let i = 0; i < NUM_CRYSTALS; ++i)
                this.tickStableState.crystalStates[i].crystalLengthScale = 0;
        }
    }

    private conditionallyStartCrystalShrink() {
        if (this.crystalLengthScaleLerp.isInState(LerpState.DoneIncreasing)) {
            this.crystalLengthScaleLerp.conditionallyStartDecreasing();
            for (let i = 0; i < NUM_CRYSTALS; ++i)
                this.tickStableState.crystalStates[i].crystalLengthScale = 0;
        }
    }

    private currentHours: number = 0;
    private currentMinutes: number = 0;
    private currentSeconds: number = 0;
    private currentMilliseconds: number = 0;
    private updateClockFromLatestRTC() {
        const date = new Date();
        this.currentHours = date.getHours();
        this.currentMinutes = date.getMinutes();
        this.currentSeconds = date.getSeconds();
        this.currentMilliseconds = date.getMilliseconds();
    }

    private orbRenderObjects: OrbRenderObject[] = nArray(NUM_ORBS, () => new OrbRenderObject());
    private crystalRenderObjects: CrystalRenderObject[] = nArray(NUM_CRYSTALS, () => new CrystalRenderObject());
    private sortedRenderObjects: BaseRenderObject[] = [...this.orbRenderObjects, ...this.crystalRenderObjects];

    private crystalRenderBlockTemplate: CrystalRenderBlock = {
        texScrollStep: 0,
        //numQuads: 0,
        //posPerVertRef: [],
        //normPerQuadRef: [],
        //stPerVertRef: [],
        objMtx: mat4.create(),
        //projMtxRef: Mat4Identity,
        //camMtxRef: Mat4Identity,
        objScale: vec3.fromValues(1, 1, 1),
        refractionRGBA: vec4.fromValues(0, 0, 0, 128),
        viewDotScale: 128,
        refractBumpRGBA: vec4.fromValues(8, 8, 8, 128),
        stScroll: vec2.fromValues(-0.008, -0.008),
        refraction: 1,
        flowRGBA: vec4.fromValues(0, 0, 0, 128),
        bumpRGBA: vec4.fromValues(40, 40, 40, 128)
    };

    private updateRenderCrystals(viewMatrix: mat4) {
        for (let i = 0; i < NUM_CRYSTALS; ++i) {
            const hourIdx = (i + this.drawStableState.activeHourIdx) % NUM_CRYSTALS;
            const crystalState = this.drawStableState.crystalStates[hourIdx];

            this.crystalRenderBlockTemplate.objScale[1] = crystalState.crystalLengthScale;

            this.crystalRenderBlockTemplate.texScrollStep = hourIdx;

            mat4.identity(this.crystalRenderBlockTemplate.objMtx);
            mat4.rotateZ(this.crystalRenderBlockTemplate.objMtx, this.crystalRenderBlockTemplate.objMtx,
                this.drawStableState.topHourBaseRotationUint16 * -MathConstants.TAU / 0x10000);
            mat4.rotateY(this.crystalRenderBlockTemplate.objMtx, this.crystalRenderBlockTemplate.objMtx,
                this.drawStableState.minuteRotationUint16 * -MathConstants.TAU / 0x10000);
            mat4.rotateZ(this.crystalRenderBlockTemplate.objMtx, this.crystalRenderBlockTemplate.objMtx,
                i * -MathConstants.TAU / NUM_CRYSTALS);
            mat4.translate(this.crystalRenderBlockTemplate.objMtx, this.crystalRenderBlockTemplate.objMtx, CRYSTAL_Y_TRANSLATE);
            mat4.rotateY(this.crystalRenderBlockTemplate.objMtx, this.crystalRenderBlockTemplate.objMtx,
                this.drawStableState.minuteRotationUint16 * 4 * -MathConstants.TAU / 0x10000);

            vec4.copy(this.crystalRenderBlockTemplate.refractionRGBA, crystalState.refractionRGBA);

            vec4.copy(this.crystalRenderBlockTemplate.flowRGBA, crystalState.flowRGBA);

            if (i === 0) {
                this.crystalRenderBlockTemplate.viewDotScale = 200;
                this.crystalRenderObjects[i].setCrystal(crystalState.crystalFillInterp, this.crystalRenderBlockTemplate, viewMatrix,
                    this.drawStableState.mainCrystalRefractionRGBA, 100, this.drawStableState.mainCrystalReflectionRGBA);
            } else {
                this.crystalRenderBlockTemplate.viewDotScale = 160;
                this.crystalRenderObjects[i].setCrystal(-1, this.crystalRenderBlockTemplate, viewMatrix,
                    this.drawStableState.mainCrystalRefractionRGBA, 0, this.drawStableState.mainCrystalReflectionRGBA);
            }
        }
    }

    private updateRenderOrbs() {

    }

    private updateRenderObjects(viewMatrix: mat4) {
        this.updateRenderCrystals(viewMatrix);
        this.updateRenderOrbs();
        this.sortedRenderObjects.sort((a, b) => a.getZOffset() - b.getZOffset());
    }

    private drawRefractivePass(withCrystals: boolean) {
        for (let i = 0; i < this.sortedRenderObjects.length; ++i) {
            const renderObject = this.sortedRenderObjects[i];
            if (renderObject instanceof OrbRenderObject) {
                this.drawOrb(renderObject);
            } else if (withCrystals && renderObject instanceof CrystalRenderObject) {
                this.drawCrystalRefractivePass(renderObject);
            }
        }
    }

    private drawReflectivePass(withCrystals: boolean) {
        if (!withCrystals)
            return;
        for (let i = 0; i < this.sortedRenderObjects.length; ++i) {
            const renderObject = this.sortedRenderObjects[i];
            if (renderObject instanceof CrystalRenderObject) {
                this.drawCrystalReflectivePass(renderObject);
            }
        }
    }

    private drawOrb(object: OrbRenderObject) {

    }

    private topCrystalInnerMtx: mat4 = mat4.create();
    private topCrystalOuterMtx: mat4 = mat4.create();
    private drawCrystalRefractivePass(object: CrystalRenderObject) {
        const block = object.block;
        if (block.objScale[1] < 0)
            return;

        if (object.scaleInterp > 0) {
            vec3.copy(scratchVec, block.objScale);
            scratchVec[1] *= object.scaleInterp;
            mat4.scale(this.topCrystalInnerMtx, block.objMtx, scratchVec);

            mat4.translate(scratchMtx, block.objMtx, [0, block.objScale[1] * 26 * object.scaleInterp, 0]);
            vec3.copy(scratchVec, block.objScale);
            scratchVec[1] *= 1 - object.scaleInterp;
            mat4.scale(this.topCrystalOuterMtx, scratchMtx, scratchVec);

            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), false, this.topCrystalInnerMtx, block.refractionRGBA, block.refraction, [0.5,0.5,0.5]);
            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), false, this.topCrystalOuterMtx, block.refractionRGBA, block.refraction, [0.5,0.5,0.5]);

            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), true, this.topCrystalInnerMtx, block.refractionRGBA, block.refraction, [0,0,0]);
            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), true, this.topCrystalOuterMtx, block.refractionRGBA, block.refraction, [0,0,0]);
        } else {
            mat4.scale(scratchMtx, block.objMtx, block.objScale);
            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), false, scratchMtx, block.refractionRGBA, block.refraction, [0.5,0.5,0.5]);
            this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.startInstList(), true, scratchMtx, block.refractionRGBA, block.refraction, [0,0,0]);
        }
    }

    private drawCrystalReflectivePass(object: CrystalRenderObject) {

    }

    protected stableTick() {
        this.tickStableState.frameCounter = this.frameCounter;

        this.frameCounter += 1;

        this.tickClockProgress();
        this.tickBG();
        this.updateClockFromLatestRTC();
    }

    public draw(params: DrawParams) {
        this.resetInstLists();
        this.startInstList();
        this.drawBG();

        this.updateRenderObjects(params.viewerInput.camera.viewMatrix);

        const withCrystals = this.drawStableState.crystalStates[0].crystalLengthScale > 0.05;
        this.drawRefractivePass(withCrystals);
        this.drawReflectivePass(withCrystals);

        params.builder.pushPass((pass) => {
            pass.setDebugName("Main Pass");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, params.mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, params.mainDepthTargetID);
            pass.exec((passRenderer, scope) => {
                this.instLists[0].drawOnPassRenderer(this.biosScene.renderHelper.renderCache, passRenderer);
            });
        });

        for (let i = 1; i <= this.curInstListIdx; ++i) {
            const sceneColorResolveTextureID = params.builder.resolveRenderTarget(params.mainColorTargetID);
            params.builder.pushPass((pass) => {
                pass.setDebugName(`Pass ${i}`);
                pass.attachResolveTexture(sceneColorResolveTextureID);
                pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, params.mainColorTargetID);
                pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, params.mainDepthTargetID);
                pass.exec((passRenderer, scope) => {
                    const sceneColorTexture = scope.getResolveTextureForID(sceneColorResolveTextureID);
                    this.instLists[i].resolveLateSamplerBinding("sceneColor", {
                        gfxTexture: sceneColorTexture,
                        gfxSampler: this.biosScene.clampSampler
                    });
                    this.instLists[i].drawOnPassRenderer(this.biosScene.renderHelper.renderCache, passRenderer);
                });
            });
        }
    }

    public updateCameraMatrix(cameraMatrix: mat4, roll: boolean) {
        vec3.add(scratchVec, this.cameraPosition, this.eyeDirection);
        mat4.targetTo(cameraMatrix, this.cameraPosition, scratchVec, roll ? this.eyeUpDirection : [0, 1, 0]);
    }

    constructor(biosScene: IBIOSScene) {
        super(biosScene, STABLE_STATE_OPS);
        vec3.set(this.eyeDirection, 0, 0, 1);
        vec3.set(this.eyeUpDirection, 0, 1, 0);
        vec3.set(this.cameraPosition, 0, 0, -103);
        this.updateClockFromLatestRTC();
        this.initClockProgress();

        // TODO: remove test
        this.conditionallyStartCrystalGrow();
    }
}
