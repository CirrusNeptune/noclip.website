import {mat4} from "gl-matrix";
import {
    makeBackbufferDescSimple,
    opaqueBlackFullClearRenderPassDescriptor,
    standardFullClearRenderPassDescriptor
} from "../gfx/helpers/RenderGraphHelpers";
import {fillMatrix4x4} from "../gfx/helpers/UniformBufferHelpers";
import {GfxDevice, GfxMipFilterMode, GfxSampler, GfxTexFilterMode, GfxWrapMode} from "../gfx/platform/GfxPlatform";
import {GfxrAttachmentSlot} from "../gfx/render/GfxRenderGraph";
import {GfxRenderHelper} from "../gfx/render/GfxRenderHelper";
import {GfxRenderInst, GfxRenderInstList} from "../gfx/render/GfxRenderInstManager";
import {SceneAudioDesc, SceneContext, SceneDesc, SceneGroup} from "../SceneBase";
import {SceneAudioContext, SceneGfx, ViewerRenderInput} from "../viewer";
import * as UI from "../ui";
import {FakeTextureHolder} from "../TextureHolder";
import {BIOSROM} from "./BIOSROM";
import OsdSnd, {HD, SequenceState} from "./OsdSnd/OsdSnd";
import {assertExists} from "../util";
import {ResourceID} from "./ResourceIDs";
import IBIOSScene from "./IBIOSScene";
import OpeningFogGeometry from "./Render/OpeningFog";
import {BaseProgram} from "./Render/Base";
import TowersGeometry from "./Render/Towers";
import InputManager from "../InputManager";
import {CameraController} from "../Camera";
import {MCHistoryEntry, PlayerSimulationParams, simulatePlayer} from "./MCHistory";
import OpeningFlaresGeometry from "./Render/OpeningFlares";
import LinesGeometry from "./Render/Lines";
import MultipassCubeGeometry from "./Render/MultipassCube";
import {OpeningModule, OverallOpeningState} from "./Opening";
import {BIOSModule} from "./BIOSModule";
import ArrayBufferSlice from "../ArrayBufferSlice";
import ClockBGGeometry from "./Render/ClockBG";
import {ClockModule} from "./Clock";
import ClockCrystalGeometry from "./Render/ClockCrystal";

export const noclipSpaceFromOsdSysSpace = mat4.fromValues(
    -1, 0,  0, 0,
    0, 1, 0, 0,
    0, 0,  1, 0,
    0, 0,  0, 1,
);

const scratchMat: mat4 = mat4.create();

class BIOSScene implements SceneGfx, IBIOSScene {
    public renderHelper: GfxRenderHelper;
    private inputManager: InputManager;

    public linearSampler: GfxSampler;
    public clampSampler: GfxSampler;

    public towersGeometry: TowersGeometry;
    public openingFogGeometry: OpeningFogGeometry;
    public openingFlaresGeometry: OpeningFlaresGeometry;
    public linesGeometry: LinesGeometry;
    public multipassCubeGeometry: MultipassCubeGeometry;
    public clockBGGeometry: ClockBGGeometry;
    public clockCrystalGeometry: ClockCrystalGeometry;

    public textureHolder = new FakeTextureHolder([]);

    private osdSnd: OsdSnd | null = null;
    private sequenceStates: Map<ResourceID, SequenceState> = new Map<ResourceID, SequenceState>();

    public mcHistory: MCHistoryEntry[];
    public cameraAspect: number = 1.0;

    private activeModule: BIOSModule<any>;

    public onstatechanged!: () => void;

    constructor(private sceneContext: SceneContext, private biosROM: BIOSROM) {
        this.inputManager = sceneContext.inputManager;
        sceneContext.viewerInput.camera.fovY = 0.4604391746;

        biosROM.textures.forEach((texture) => {
            this.textureHolder.viewerTextures.push(texture);
        });

        this.renderHelper = new GfxRenderHelper(sceneContext.device, sceneContext);

        const cache = this.renderHelper.renderCache;

        this.towersGeometry = new TowersGeometry(cache, this.biosROM);
        this.openingFogGeometry = new OpeningFogGeometry(cache, this.biosROM);
        this.openingFlaresGeometry = new OpeningFlaresGeometry(cache, this.biosROM);
        this.linesGeometry = new LinesGeometry(cache);
        this.multipassCubeGeometry = new MultipassCubeGeometry(cache, this.biosROM);
        this.clockBGGeometry = new ClockBGGeometry(cache, this.biosROM);
        this.clockCrystalGeometry = new ClockCrystalGeometry(cache, this.biosROM);

        this.linearSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
        });
        this.clampSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            wrapS: GfxWrapMode.Clamp,
            wrapT: GfxWrapMode.Clamp,
        });

        const playerSimulationParams: PlayerSimulationParams = {
            numGames: 5,
            numSessions: 20000,
            gameSlotAllocationSeed: 100,
            favoriteDistributionSeed: 1234,
            gameSelectionSeed: 5678,
        };
        this.mcHistory = simulatePlayer(playerSimulationParams);

        //this.activeModule = new OpeningModule(this, OverallOpeningState.OpeningScreen);
        this.activeModule = new ClockModule(this);
    }

    public receiveAudioContext(audioContext: SceneAudioContext): void {
        this.osdSnd = new OsdSnd(audioContext);
        const uniqueHDs = new Set<HD>();
        this.biosROM.sequences.forEach((pair, id) => {
            this.sequenceStates.set(id, this.osdSnd!.addSQ(pair.hd, pair.sq));
            uniqueHDs.add(pair.hd);
        });
        this.osdSnd.start();
        uniqueHDs.forEach((hd) => this.osdSnd!.precacheSamples(hd));

        // Give audio context some time to start
        setTimeout(() => this.osdSnd!.startSeq(assertExists(this.sequenceStates.get(ResourceID.SNDBOOTS))), 200);
    }

    private freeCam: boolean = false;
    private lastWorldMatrix: mat4 | null = null;
    private updateAndFillSceneParams(template: GfxRenderInst, viewerInput: ViewerRenderInput): void {
        const wasFreeCam = this.freeCam;

        if (this.lastWorldMatrix === null) {
            this.lastWorldMatrix = mat4.clone(viewerInput.camera.worldMatrix);
        } else if (!mat4.equals(this.lastWorldMatrix, viewerInput.camera.worldMatrix)) {
            this.freeCam = true;
            mat4.copy(this.lastWorldMatrix, viewerInput.camera.worldMatrix);
        }

        if (this.inputManager.isKeyDownEventTriggered("KeyF")) {
            this.freeCam = !this.freeCam;
        }

        if (this.freeCam !== wasFreeCam) {
            this.onstatechanged();
        }

        if (!this.freeCam) {
            this.activeModule.updateCameraMatrix(viewerInput.camera.worldMatrix, true);
            viewerInput.camera.worldMatrixUpdated();
            mat4.copy(this.lastWorldMatrix, viewerInput.camera.worldMatrix);
        } else if (!wasFreeCam) {
            this.activeModule.updateCameraMatrix(viewerInput.camera.worldMatrix, false);
            viewerInput.camera.worldMatrixUpdated();
            mat4.copy(this.lastWorldMatrix, viewerInput.camera.worldMatrix);
        }

        const data = template.allocateUniformBufferF32(BaseProgram.ub_SceneParams, 32);
        let offs = 0;

        mat4.mul(scratchMat, viewerInput.camera.clipFromWorldMatrix, noclipSpaceFromOsdSysSpace);
        offs += fillMatrix4x4(data, offs, scratchMat);

        mat4.mul(scratchMat, viewerInput.camera.viewMatrix, noclipSpaceFromOsdSysSpace);
        offs += fillMatrix4x4(data, offs, scratchMat);
    }

    public serializeSaveState(dst: ArrayBuffer, offs: number): number {
        const view = new DataView(dst);
        view.setUint8(offs++, this.freeCam ? 1 : 0);
        return offs;
    }

    public deserializeSaveState(src: ArrayBufferSlice): void {
        const view = src.createDataView();
        let offs = 0;
        if (offs < view.byteLength) {
            this.freeCam = !!view.getUint8(offs++);
        }
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        this.cameraAspect = viewerInput.camera.aspect;
        this.activeModule.tick(viewerInput.time / 1000.0);

        // Prepare for rendering.
        this.renderHelper.debugDraw.beginFrame(
            viewerInput.camera.projectionMatrix,
            viewerInput.camera.viewMatrix,
            viewerInput.backbufferWidth,
            viewerInput.backbufferHeight
        );
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts([
            { numSamplers: 1, numUniformBuffers: 2 },
        ]);
        this.updateAndFillSceneParams(template, viewerInput);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');

        // This will update our uniforms and populate the inst lists.
        this.activeModule.draw({
            builder,
            mainColorTargetID,
            mainDepthTargetID
        });

        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.debugDraw.pushPasses(builder, mainColorTargetID, mainDepthTargetID);
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);
        this.renderHelper.prepareToRender();
        builder.execute();
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(0.015);
    }

    public createPanels(): UI.Panel[] {
        const renderSettingsPanel = new UI.Panel();
        renderSettingsPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderSettingsPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Settings');

        return [renderSettingsPanel];
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        this.towersGeometry.destroy(device);
        this.openingFogGeometry.destroy(device);
        this.openingFlaresGeometry.destroy(device);
        this.linesGeometry.destroy(device);
        this.multipassCubeGeometry.destroy(device);
        this.clockBGGeometry.destroy(device);
        this.clockCrystalGeometry.destroy(device);

        this.biosROM.destroy(device);

        if (this.osdSnd !== null)
            this.osdSnd.stop();
    }
}

class OsdSysSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string, public audio?: SceneAudioDesc) {
    }

    public async createScene(device: GfxDevice, sceneContext: SceneContext): Promise<SceneGfx> {
        const biosBuffer = await sceneContext.dataFetcher.fetchData("PS2OsdSys/SCPH-70004_BIOS_V12_PAL_200.BIN");
        return new BIOSScene(sceneContext, new BIOSROM(biosBuffer, sceneContext.device));
    }
}

export const sceneGroup: SceneGroup = {
    id: "PS2Bios",
    name: "PS2 Bios",
    sceneDescs: [
        new OsdSysSceneDesc("BIOS", "BIOS", {
            initiallyPausedIfNotUserActivated: true,
            playPauseAudioContextWithScene: true,
        }),
    ],
};
