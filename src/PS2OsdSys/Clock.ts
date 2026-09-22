import {BIOSModule, DrawParams, StableStateOps} from "./BIOSModule";
import {lerp, MathConstants} from "../MathHelpers";
import IBIOSScene from "./IBIOSScene";
import {mat4, vec3} from "gl-matrix";
import {GfxRenderInstList} from "../gfx/render/GfxRenderInstManager";
import {assert} from "../util";
import {GfxrAttachmentSlot} from "../gfx/render/GfxRenderGraph";

const scratchVec: vec3 = vec3.create();

/**
 * Any animated variables directly used in drawing should be kept here
 * and linear interpolated with the previous to resolve the stable tick results
 */
interface StableState {
    frameCounter: number,
    bgColorBias: vec3,
    bgScrollAnim: number,
}

const STABLE_STATE_OPS: StableStateOps<StableState> = {
    makeStableState: () => {
        return {
            frameCounter: 0,
            bgColorBias: vec3.create(),
            bgScrollAnim: 0,
        };
    },

    copyStableState: (to: StableState, from: StableState) => {
        to.frameCounter = from.frameCounter;
        vec3.copy(to.bgColorBias, from.bgColorBias);
        to.bgScrollAnim = from.bgScrollAnim;
    },

    interpolateStableState: (out: StableState, a: StableState, b: StableState, alpha: number) => {
        out.frameCounter = lerp(a.frameCounter, b.frameCounter, alpha);
        vec3.lerp(out.bgColorBias, a.bgColorBias, b.bgColorBias, alpha);
        out.bgScrollAnim = lerp(a.bgScrollAnim, b.bgScrollAnim, alpha);
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

    private drawCrystal(objMatrix: mat4) {
        this.startInstList();
        this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.getCurInstList(), false, objMatrix, [0.5,0.5,0.5]);
        this.startInstList();
        this.biosScene.clockCrystalGeometry.draw(this.biosScene, this.getCurInstList(), true, objMatrix, [0,0,0]);
    }

    protected stableTick() {
        this.tickStableState.frameCounter = this.frameCounter;

        this.frameCounter += 1;

        this.tickBG();
    }

    public draw(params: DrawParams) {
        this.resetInstLists();
        this.startInstList();
        this.drawBG();

        for (let i = 0; i < 12; ++i) {
            const crystalMatrix = mat4.create();
            mat4.rotateZ(crystalMatrix, crystalMatrix, i * MathConstants.TAU / 12.0);
            mat4.translate(crystalMatrix, crystalMatrix, [0, 12, 0]);
            this.drawCrystal(crystalMatrix);
        }

        params.builder.pushPass((pass) => {
            pass.setDebugName("Main Pass");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, params.mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, params.mainDepthTargetID);
            pass.exec((passRenderer, scope) => {
                this.instLists[0].drawOnPassRenderer(this.biosScene.renderHelper.renderCache, passRenderer);
            });
        });

        for (let i = 1; i < (this.curInstListIdx + 1); ++i) {
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
    }
}
