import {mat4, vec3, vec4} from "gl-matrix";
import {
    makeBackbufferDescSimple,
    opaqueBlackFullClearRenderPassDescriptor,
    standardFullClearRenderPassDescriptor
} from "../gfx/helpers/RenderGraphHelpers";
import { fillMatrix4x4 } from "../gfx/helpers/UniformBufferHelpers";
import { GfxDevice, GfxMipFilterMode, GfxSampler, GfxTexFilterMode, GfxWrapMode } from "../gfx/platform/GfxPlatform";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper";
import { GfxRenderInst, GfxRenderInstList } from "../gfx/render/GfxRenderInstManager";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { SceneGfx, ViewerRenderInput } from "../viewer";
import * as UI from "../ui";
import { FakeTextureHolder } from "../TextureHolder";
import {BIOSROM} from "./BIOSROM";
import OsdSnd, {HD, SequenceState} from "./OsdSnd/OsdSnd";
import {assert, assertExists, nArray} from "../util";
import {ResourceID} from "./ResourceIDs";
import {clamp, lerp, MathConstants, setMatrixTranslation} from "../MathHelpers";
import RenderInterface from "./Render/RenderInterface";
import OpeningFogGeometry from "./Render/OpeningFog";
import {BaseProgram} from "./Render/Base";
import TowersGeometry, {NUM_TOWERS, TOWER_GRID_HEIGHT, TOWER_GRID_WIDTH} from "./Render/Towers";
import InputManager from "../InputManager";
import {CameraController, CameraUpdateResult, FPSCameraController} from "../Camera";
import {MCHistoryEntry, NUM_HISTORY_SLOTS, PlayerSimulationParams, simulatePlayer} from "./MCHistory";
import {Green} from "../Color";
import OpeningFlaresGeometry, {NUM_FLARE_OVERDRAWS, NUM_FLARES} from "./Render/OpeningFlares";
import LinesGeometry from "./Render/Lines";
import MultipassCubeGeometry from "./Render/MultipassCube";

export const noclipSpaceFromOsdSysSpace = mat4.fromValues(
    -1, 0,  0, 0,
    0, 1, 0, 0,
    0, 0,  1, 0,
    0, 0,  0, 1,
);

const scratchVec: vec3 = vec3.create();
const scratchVec2: vec3 = vec3.create();
const halfVec: vec3 = vec3.fromValues(0.5, 0.5, 0.5);
const scratchMat: mat4 = mat4.create();

function zeroMatrix(out: mat4) {
    for (let i = 0; i < 16; ++i) {
        out[i] = 0.0;
    }
}

enum OverallOpeningState {
    // Added for noclip so stableTick() can return rather
    // than being stuck in a modal loop like the original
    InitForNoclip = -1,
    OpeningScreen,
    WarningScreen,
    Done
}

enum ScreenProcessingState {
    NeedsInit,
    NeedsUpdate,
    Done
}

enum AnimationProcessingState {
    Zero,
    One,
    Two,
    Three,
    Four,
    Five,
    Six,
    Seven,
}

enum TextFadingState {
    DoneFading = -1,
    NotYetFading,
    Fading
}

/**
 * Any animated variables directly used in drawing should be kept here
 * and linear interpolated with the previous to resolve the stable tick results
 */
interface StableState {
    frameCounter: number,
    cameraPosition: vec3,
    cameraRoll: number,
    sceTextAlpha: number,
    warningTextAlpha: number,
}

function makeStableState(): StableState {
    return {
        frameCounter: 0,
        cameraPosition: vec3.create(),
        cameraRoll: 0,
        sceTextAlpha: 0,
        warningTextAlpha: 0,
    }
}

function copyStableState(to: StableState, from: StableState) {
    to.frameCounter = from.frameCounter;
    vec3.copy(to.cameraPosition, from.cameraPosition);
    to.cameraRoll = from.cameraRoll;
    to.sceTextAlpha = from.sceTextAlpha;
    to.warningTextAlpha = from.warningTextAlpha;
}

function interpolateStableState(out: StableState, a: StableState, b: StableState, alpha: number) {
    out.frameCounter = lerp(a.frameCounter, b.frameCounter, alpha);
    vec3.lerp(out.cameraPosition, a.cameraPosition, b.cameraPosition, alpha);
    out.cameraRoll = lerp(a.cameraRoll, b.cameraRoll, alpha);
    out.sceTextAlpha = lerp(a.sceTextAlpha, b.sceTextAlpha, alpha);
    out.warningTextAlpha = lerp(a.warningTextAlpha, b.warningTextAlpha, alpha);
}

/**
 * Provide BIOS camera animation via the camera controller infrastructure.
 * The user has the ability to take over at any time.
 */
export class BIOSCameraController extends FPSCameraController {
    private sceneTime: number = 0;
    private didInit: boolean = false;
    constructor(private scene: BIOSScene) {
        super();
    }

    public override update(inputManager: InputManager, dt: number, sceneTimeScale: number): CameraUpdateResult {
        const deltaTime = dt * sceneTimeScale / 1000;
        this.sceneTime += deltaTime;

        this.scene.cameraAspect = this.camera.aspect;
        this.scene.tick(this.sceneTime);
        if (!this.didInit) {
            this.scene.updateCameraMatrix(this.camera.worldMatrix);
            this.setKeyMoveSpeed(0.1);
            this.camera.setPerspective(0.4604391746, this.camera.aspect, 1, 65536);
            window.main.ui.viewerSettings.setupFromCamera(this, this.camera);
            this.didInit = true;
        }
        //this.scene.updateCameraMatrix(this.camera.worldMatrix);
        super.update(inputManager, dt, sceneTimeScale);
        this.camera.worldMatrixUpdated();
        //console.log(`${this.camera.worldMatrix[12]}, ${this.camera.worldMatrix[13]}, ${this.camera.worldMatrix[14]}`);

        // Set result to unchanged to prevent needless savestate creation during playback.
        return CameraUpdateResult.Unchanged;
    }
}

class BIOSScene implements SceneGfx, RenderInterface {
    public renderHelper: GfxRenderHelper;

    public mainInstList = new GfxRenderInstList();
    public backfaceCubeInstList = new GfxRenderInstList();
    public frontfaceCubeInstList = new GfxRenderInstList();
    public textInstList = new GfxRenderInstList();

    public linearSampler: GfxSampler;
    public clampSampler: GfxSampler;

    private towersGeometry: TowersGeometry;
    private openingFogGeometry: OpeningFogGeometry;
    private openingFlaresGeometry: OpeningFlaresGeometry;
    private linesGeometry: LinesGeometry;
    private multipassCubeGeometry: MultipassCubeGeometry;

    public textureHolder = new FakeTextureHolder([]);

    private osdSnd: OsdSnd;
    private sequenceStates: Map<ResourceID, SequenceState> = new Map<ResourceID, SequenceState>();

    private mcHistory: MCHistoryEntry[];

    constructor(private sceneContext: SceneContext, private biosROM: BIOSROM) {
        this.osdSnd = new OsdSnd();
        const uniqueHDs = new Set<HD>();
        this.biosROM.sequences.forEach((pair, id) => {
            this.sequenceStates.set(id, this.osdSnd.addSQ(pair.hd, pair.sq));
            uniqueHDs.add(pair.hd);
        });
        this.osdSnd.start();
        uniqueHDs.forEach((hd) => this.osdSnd.precacheSamples(hd));

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

        // Give audio context some time to start
        setTimeout(() => this.osdSnd.startSeq(assertExists(this.sequenceStates.get(ResourceID.SNDCLOKS))), 200);
    }

    private fillSceneParams(template: GfxRenderInst, viewerInput: ViewerRenderInput): void {
        const data = template.allocateUniformBufferF32(BaseProgram.ub_SceneParams, 32);
        let offs = 0;

        mat4.mul(scratchMat, viewerInput.camera.clipFromWorldMatrix, noclipSpaceFromOsdSysSpace);
        offs += fillMatrix4x4(data, offs, scratchMat);

        mat4.mul(scratchMat, viewerInput.camera.viewMatrix, noclipSpaceFromOsdSysSpace);
        offs += fillMatrix4x4(data, offs, scratchMat);
    }

    static readonly STABLE_TICK_RATE = 1.0 / 60.0;
    private lastStableTickTime: number | null = null;
    private tickStableState: StableState = makeStableState();
    private prevStableState: StableState = makeStableState();
    private drawStableState: StableState = makeStableState();

    private frameCounter: number = 0;
    private entryOverallOpeningState = OverallOpeningState.OpeningScreen;
    private overallOpeningState: OverallOpeningState = OverallOpeningState.InitForNoclip;
    private requestedOverallOpeningState: OverallOpeningState = OverallOpeningState.InitForNoclip;
    private screenProcessingState: ScreenProcessingState = ScreenProcessingState.NeedsInit;
    private animationProcessingState: AnimationProcessingState = AnimationProcessingState.Zero;
    private sceTextState: TextFadingState = TextFadingState.DoneFading;
    private warningTextState: TextFadingState = TextFadingState.DoneFading;

    private cameraPosition_d: vec3 = vec3.create();
    private cameraPosition_dd: vec3 = vec3.create();
    private cameraPosition_ddd: vec3 = vec3.create();

    private cameraRoll_d: number = 0;
    private cameraRoll_dd: number = 0;

    private animationReadyForTransitionToNextScreen: boolean = false;
    private fadeWarningTextOut: boolean = false;

    private sceTextAlpha_dx_dt: number = 0;

    private openingInitAnimation() {
        this.animationProcessingState = AnimationProcessingState.Zero;
        vec3.set(this.cameraPosition_d, 0, 0, 0.004);
        vec3.set(this.cameraPosition_dd, 0, 0, 0);
        this.cameraPosition_ddd[2] = 0.0;
        this.cameraRoll_d = 0.001;
        this.cameraRoll_dd = 0.0;
        this.animationReadyForTransitionToNextScreen = false;
    }

    private towerGridTranslations: vec3[] = nArray(NUM_TOWERS, vec3.create);
    private towerGridZDisplacements1: number[] = nArray(NUM_TOWERS, () => { return 0.0; });
    private towerGridZDisplacements2: number[] = nArray(NUM_TOWERS, () => { return 0.0; });
    private towerGridZScales: number[] = nArray(NUM_TOWERS, () => { return 0.0; });
    private towerGridZDisplacedColorMultiplier: number[] = nArray(NUM_TOWERS, () => { return 0.0; });
    private towerEnabled: boolean[] = nArray(NUM_TOWERS, () => { return false; });
    private towerColorMultipliersBase: number[] = nArray(20 * 20, () => { return 0.0; });

    static readonly TOWER_GRID_BASE_TRANSLATIONS: number[] = [
        -137428 / 10000, 117512 / 10000, -25366 / 10000,
        -137428 / 10000, 104512 / 10000, -25366 / 10000,
        -137428 / 10000, 91512 / 10000, -25366 / 10000,
        -131428 / 10000, 78512 / 10000, -25366 / 10000,
        -137428 / 10000, 65512 / 10000, -65517 / 10000,
        -137428 / 10000, 52512 / 10000, -25366 / 10000,
        -137428 / 10000, 39512 / 10000, -25366 / 10000,
        -137428 / 10000, 26512 / 10000, -25366 / 10000,
        -137428 / 10000, 13512 / 10000, -25366 / 10000,
        -124428 / 10000, 117512 / 10000, -25366 / 10000,
        -124428 / 10000, 104512 / 10000, -25366 / 10000,
        -124428 / 10000, 91512 / 10000, -25366 / 10000,
        -121428 / 10000, 78512 / 10000, -9330 / 10000,
        -124428 / 10000, 65512 / 10000, -25366 / 10000,
        -124428 / 10000, 52512 / 10000, -25366 / 10000,
        -124428 / 10000, 39512 / 10000, -25366 / 10000,
        -124428 / 10000, 26512 / 10000, -25366 / 10000,
        -124428 / 10000, 13512 / 10000, -25366 / 10000,
        -111428 / 10000, 117512 / 10000, -25366 / 10000,
        -111428 / 10000, 104512 / 10000, -25366 / 10000,
        -111428 / 10000, 91512 / 10000, -32422 / 10000,
        -111428 / 10000, 78512 / 10000, -25366 / 10000,
        -111428 / 10000, 65512 / 10000, -31781 / 10000,
        -111428 / 10000, 52512 / 10000, -25366 / 10000,
        -111428 / 10000, 39512 / 10000, -25366 / 10000,
        -111428 / 10000, 26512 / 10000, -25366 / 10000,
        -111428 / 10000, 13512 / 10000, -25366 / 10000,
        -98428 / 10000, 117512 / 10000, -25366 / 10000,
        -98428 / 10000, 104512 / 10000, -25366 / 10000,
        -98428 / 10000, 91512 / 10000, -25366 / 10000,
        -98428 / 10000, 78512 / 10000, -33705 / 10000,
        -98428 / 10000, 65512 / 10000, -40119 / 10000,
        -98428 / 10000, 52512 / 10000, -25366 / 10000,
        -98428 / 10000, 39512 / 10000, -25366 / 10000,
        -98428 / 10000, 26512 / 10000, -25366 / 10000,
        -98428 / 10000, 13512 / 10000, -32422 / 10000,
        -85428 / 10000, 117512 / 10000, -25366 / 10000,
        -85428 / 10000, 104512 / 10000, -25366 / 10000,
        -85428 / 10000, 91512 / 10000, -25366 / 10000,
        -85428 / 10000, 78512 / 10000, -54054 / 10000,
        -85428 / 10000, 65512 / 10000, -44491 / 10000,
        -85428 / 10000, 52512 / 10000, -25366 / 10000,
        -85428 / 10000, 39512 / 10000, -35629 / 10000,
        -85428 / 10000, 26512 / 10000, -25366 / 10000,
        -85428 / 10000, 13512 / 10000, -25366 / 10000,
        -72428 / 10000, 117512 / 10000, -25366 / 10000,
        -72428 / 10000, 104512 / 10000, -25366 / 10000,
        -72428 / 10000, 91512 / 10000, -25366 / 10000,
        -72428 / 10000, 78512 / 10000, -54097 / 10000,
        -72428 / 10000, 65512 / 10000, -38195 / 10000,
        -72428 / 10000, 52512 / 10000, -25366 / 10000,
        -72428 / 10000, 39512 / 10000, -35629 / 10000,
        -72428 / 10000, 26512 / 10000, -25366 / 10000,
        -72428 / 10000, 13512 / 10000, -25366 / 10000,
        -59428 / 10000, 117512 / 10000, -25366 / 10000,
        -59428 / 10000, 104512 / 10000, -25366 / 10000,
        -59428 / 10000, 91512 / 10000, -25366 / 10000,
        -59428 / 10000, 78512 / 10000, -33705 / 10000,
        -59428 / 10000, 65512 / 10000, -44491 / 10000,
        -59428 / 10000, 52512 / 10000, -38195 / 10000,
        -59428 / 10000, 39512 / 10000, -309 / 10000,
        -59428 / 10000, 26512 / 10000, -25366 / 10000,
        -59428 / 10000, 13512 / 10000, -25366 / 10000,
        -46428 / 10000, 117512 / 10000, -25366 / 10000,
        -46428 / 10000, 104512 / 10000, -25366 / 10000,
        -46428 / 10000, 91512 / 10000, -25366 / 10000,
        -46428 / 10000, 78512 / 10000, -25366 / 10000,
        -46428 / 10000, 65512 / 10000, -38195 / 10000,
        -46428 / 10000, 52512 / 10000, -25366 / 10000,
        -46428 / 10000, 39512 / 10000, -25366 / 10000,
        -46428 / 10000, 26512 / 10000, -45251 / 10000,
        -46428 / 10000, 13512 / 10000, -25366 / 10000,
        -33428 / 10000, 117512 / 10000, -25366 / 10000,
        -33428 / 10000, 104512 / 10000, -25366 / 10000,
        -33428 / 10000, 91512 / 10000, -50383 / 10000,
        -33428 / 10000, 78512 / 10000, -45892 / 10000,
        -33428 / 10000, 65512 / 10000, -35629 / 10000,
        -33428 / 10000, 52512 / 10000, -45766 / 10000,
        -33428 / 10000, 39512 / 10000, -28536 / 10000,
        -33428 / 10000, 26512 / 10000, -6190 / 10000,
        -33428 / 10000, 13512 / 10000, -25366 / 10000,
        -20428 / 10000, 117512 / 10000, -25366 / 10000,
        -20428 / 10000, 104512 / 10000, -25366 / 10000,
        -20428 / 10000, 91512 / 10000, -25366 / 10000,
        -20428 / 10000, 78512 / 10000, -25366 / 10000,
        -20428 / 10000, 65512 / 10000, -33654 / 10000,
        -20428 / 10000, 52512 / 10000, -28799 / 10000,
        -20428 / 10000, 39512 / 10000, -25366 / 10000,
        -20428 / 10000, 26512 / 10000, -25366 / 10000,
        -20428 / 10000, 13512 / 10000, -25366 / 10000,
        -7428 / 10000, 117512 / 10000, -25366 / 10000,
        -7428 / 10000, 104512 / 10000, -25366 / 10000,
        -7428 / 10000, 91512 / 10000, 7348 / 10000,
        -7428 / 10000, 78512 / 10000, -25366 / 10000,
        -7428 / 10000, 65512 / 10000, -25366 / 10000,
        -7428 / 10000, 52512 / 10000, -28554 / 10000,
        -7428 / 10000, 39512 / 10000, -42670 / 10000,
        -7428 / 10000, 26512 / 10000, -25366 / 10000,
        -7428 / 10000, 13512 / 10000, -25366 / 10000,
        5572 / 10000, 117512 / 10000, -25366 / 10000,
        5572 / 10000, 104512 / 10000, -25366 / 10000,
        5572 / 10000, 91512 / 10000, -25366 / 10000,
        5572 / 10000, 78512 / 10000, -30466 / 10000,
        5572 / 10000, 65512 / 10000, -36204 / 10000,
        5572 / 10000, 52512 / 10000, -28554 / 10000,
        5572 / 10000, 39512 / 10000, -25366 / 10000,
        5572 / 10000, 26512 / 10000, -25366 / 10000,
        5572 / 10000, 13512 / 10000, -25366 / 10000,
        18572 / 10000, 117512 / 10000, -25366 / 10000,
        18572 / 10000, 104512 / 10000, -25366 / 10000,
        18572 / 10000, 91512 / 10000, -25366 / 10000,
        18572 / 10000, 78512 / 10000, -25366 / 10000,
        18572 / 10000, 65512 / 10000, -25366 / 10000,
        18572 / 10000, 52512 / 10000, -31741 / 10000,
        18572 / 10000, 39512 / 10000, -25366 / 10000,
        18572 / 10000, 26512 / 10000, -25366 / 10000,
        18572 / 10000, 13512 / 10000, -25366 / 10000,
        31572 / 10000, 117512 / 10000, -25366 / 10000,
        31572 / 10000, 104512 / 10000, -25366 / 10000,
        31572 / 10000, 91512 / 10000, -25366 / 10000,
        31572 / 10000, 78512 / 10000, -25366 / 10000,
        31572 / 10000, 65512 / 10000, -25366 / 10000,
        31572 / 10000, 52512 / 10000, -25366 / 10000,
        31572 / 10000, 39512 / 10000, -25366 / 10000,
        31572 / 10000, 26512 / 10000, -25366 / 10000,
        31572 / 10000, 13512 / 10000, -25366 / 10000,
    ];

    static readonly TOWER_GRID_COORDINATE_ALLOCATION_TABLE: number[] = [
        0, 0,
        0, 1,
        0, 2,
        0, 3,
        1, 0,
        1, 1,

        1, 2,
        2, 0,
        2, 1,
        2, 2,
        3, 0,
        4, 0,

        4, 1,
        5, 0,
        5, 1,
        6, 0,
        6, 1,
        6, 2,

        7, 0,
        7, 1,
        8, 0,
        8, 1,
        8, 2,
        8, 3,

        9, 0,
        9, 1,
        10, 0,
        10, 1,
        10, 2,
        11, 0,

        12, 0,
        12, 1,
        13, 0,
        13, 1,
        13, 2,
        13, 3,

        1, 3,
        2, 3,
        3, 1,
        3, 2,
        3, 3,
        4, 2,

        5, 2,
        5, 3,
        5, 4,
        6, 3,
        7, 2,
        7, 3,

        9, 2,
        9, 3,
        9, 5,
        10, 3,
        10, 4,
        10, 5,

        11, 1,
        11, 2,
        11, 3,
        11, 4,
        12, 2,
        12, 3,

        0, 4,
        1, 4,
        2, 4,
        2, 5,
        2, 6,
        3, 4,

        3, 5,
        3, 6,
        4, 3,
        4, 4,
        4, 5,
        4, 6,

        5, 5,
        5, 6,
        6, 4,
        6, 5,
        7, 4,
        7, 5,

        8, 4,
        8, 5,
        8, 6,
        9, 4,
        9, 6,
        9, 7,

        12, 4,
        13, 4,
        13, 5,
        13, 6,
        13, 7,
        13, 8,

        0, 5,
        0, 6,
        1, 5,
        1, 6,
        1, 7,
        2, 7,

        0, 7,
        0, 8,
        1, 8,
        2, 8,
        3, 7,
        3, 8,

        4, 7,
        4, 8,
        5, 7,
        5, 8,
        6, 6,
        6, 7,

        6, 8,
        7, 6,
        7, 7,
        7, 8,
        8, 7,
        8, 8,

        9, 8,
        10, 6,
        10, 7,
        10, 8,
        11, 7,
        11, 8,

        11, 5,
        11, 6,
        12, 5,
        12, 6,
        12, 7,
        12, 8,
    ];

    static readonly BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1: number[] = [
        0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0
    ];

    static readonly BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2: number[] = [
        0.2, 0.4, 0.6, 0.8, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
    ];

    private openingInitTowersFog() {
        for (let i = 0; i < NUM_TOWERS; ++i) {
            this.towerEnabled[i] = false;
        }

        for (let historyIdx = 0; historyIdx < NUM_HISTORY_SLOTS; ++historyIdx) {
            const history = this.mcHistory[historyIdx];
            if (!history.allocated) {
                continue;
            }

            for (let histTowerIdx = 0; histTowerIdx < 6; ++histTowerIdx) {
                const coordTableIdx = historyIdx * (2*6) + histTowerIdx * 2;
                const x = BIOSScene.TOWER_GRID_COORDINATE_ALLOCATION_TABLE[coordTableIdx];
                const y = BIOSScene.TOWER_GRID_COORDINATE_ALLOCATION_TABLE[coordTableIdx + 1];
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                if (history.lastSetProgressBit === histTowerIdx) {
                    if (history.launchCount < 14) {
                        this.towerGridZDisplacements1[towerIdx] = BIOSScene.BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1[history.launchCount];
                        this.towerGridZDisplacements2[towerIdx] = BIOSScene.BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2[history.launchCount];
                    } else {
                        const modLaunchCount = (history.launchCount - 14) % 10 + 4;
                        this.towerGridZDisplacements1[towerIdx] = BIOSScene.BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1[modLaunchCount];
                        this.towerGridZDisplacements2[towerIdx] = BIOSScene.BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2[modLaunchCount];
                    }
                    this.towerEnabled[towerIdx] = true;
                } else if ((history.randomProgressBits >>> histTowerIdx) & 1) {
                    this.towerGridZDisplacements1[towerIdx] = 1.0;
                    this.towerGridZDisplacements2[towerIdx] = 1.0;
                    this.towerEnabled[towerIdx] = true;
                }
            }
        }

        for (let x = 0; x < TOWER_GRID_WIDTH; ++x) {
            for (let y = 0; y < TOWER_GRID_HEIGHT; ++y) {
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                const translation = this.towerGridTranslations[towerIdx];
                translation[0] = (BIOSScene.TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3] + 4.8) * 4;
                translation[1] = (BIOSScene.TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3 + 1] - 6.5) * 4;
                translation[2] = (BIOSScene.TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3 + 2] + 4) * 12 + 150;
            }
        }

        for (let x = 0; x < TOWER_GRID_WIDTH; ++x) {
            for (let y = 0; y < TOWER_GRID_HEIGHT; ++y) {
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                const translation = this.towerGridTranslations[towerIdx];
                const zDisplacement1 = this.towerGridZDisplacements1[towerIdx];
                const zDisplacement2 = this.towerGridZDisplacements2[towerIdx];
                const zDisplacementFinal = Math.max(3, zDisplacement1 * 30);
                translation[2] += zDisplacement2 * 30 - zDisplacementFinal;
                this.towerGridZScales[towerIdx] = zDisplacementFinal / 30;
                if (zDisplacement2 >= 1.0) {
                    this.towerGridZDisplacements2[towerIdx] = 1.0;
                    this.towerGridZDisplacedColorMultiplier[towerIdx] = 0;
                } else {
                    this.towerGridZDisplacedColorMultiplier[towerIdx] = ((1.0 - zDisplacement2) * 128) >>> 0;
                }
            }
        }

        this.openingInitTowerColorMultipliers();
    }

    private openingInitTowerColorMultipliers() {
        for (let x = 0; x < 20; ++x) {
            for (let y = 0; y < 20; ++y) {
                let fVar8 = -((x * 2 - 20) * 5.1 / 2 + 2.55);
                let fVar9 = -5.1 - ((y * 2 - 20) * 5.1 / 2 + 2.55);
                fVar8 = Math.sqrt(fVar8 * fVar8 + fVar9 * fVar9);
                fVar8 = clamp(((72.12489 - (fVar8 + fVar8)) * 255.0) / 72.12489, 32, 255);
                fVar9 = 5.1 - ((x * 2 - 20) * 5.1 / 2 + 2.55);
                let fVar10 = 10.2 - ((y * 2 - 20) * 5.1 / 2 + 2.55);
                fVar9 = (((72.12489 - Math.sqrt(fVar10 * fVar10 + fVar9 * fVar9) * 4.0) * 255.0) / 72.12489) / 2;
                if (fVar9 < 32) {
                    fVar8 = fVar8 + 32.0;
                } else if (fVar9 > 255) {
                    fVar8 = fVar8 + 255.0;
                } else {
                    fVar8 = fVar8 + fVar9;
                }
                fVar8 = clamp(fVar8 * 0.85 - (((((y + x) * y) / (x + 1)) % 11 - 5) * 10), 32, 220);
                this.towerColorMultipliersBase[y * 20 + x] = fVar8;
            }
        }
    }

    private towerObjectMats: mat4[] = nArray(NUM_TOWERS, mat4.create);
    private towerLightVectorMat: mat4 = mat4.create();
    private towerObjectLightVectorMats: mat4[] = nArray(NUM_TOWERS, mat4.create);
    private towerColorMultipliers: number[] = nArray(NUM_TOWERS, () => { return 0; });
    private towerTexScrolls: number[] = nArray(NUM_TOWERS, () => { return 0; });
    private eyeDirection: vec3 = vec3.create();
    private eyeUpDirection: vec3 = vec3.create();

    private tickOpeningTowers() {
    }

    private drawOpeningTowers() {
        const animYaw = Math.sin((this.drawStableState.frameCounter % 360 - 180) * MathConstants.DEG_TO_RAD) * 10 * MathConstants.DEG_TO_RAD;

        for (let x = 0; x < TOWER_GRID_WIDTH; ++x) {
            for (let y = 0; y < TOWER_GRID_HEIGHT; ++y) {
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                if (!this.towerEnabled[towerIdx]) {
                    zeroMatrix(this.towerObjectMats[towerIdx]);
                    continue;
                }

                const xPlus3 = x + 3;
                const yPlus6 = y + 6;
                const yPlus7 = y + 7;

                const iVar1 = (xPlus3 + yPlus6) * xPlus3 / yPlus7;
                let yaw = (iVar1 - ((iVar1 + 3) >> 2 << 2)) * Math.PI / 2;
                if (this.towerGridZDisplacements2[towerIdx] !== 1.0) {
                    yaw += animYaw;
                }

                mat4.fromZRotation(this.towerObjectMats[towerIdx], yaw);
                mat4.mul(this.towerObjectLightVectorMats[towerIdx], this.towerLightVectorMat, this.towerObjectMats[towerIdx]);
                this.towerObjectMats[towerIdx][10] = this.towerGridZScales[towerIdx];
                setMatrixTranslation(this.towerObjectMats[towerIdx], this.towerGridTranslations[towerIdx]);

                this.towerColorMultipliers[towerIdx] = this.towerColorMultipliersBase[xPlus3 * 20 + yPlus6] / 255.0;

                const iVar1b = (xPlus3 + yPlus6) * (x + 8);
                this.towerTexScrolls[towerIdx] = (iVar1b / yPlus7 + ((xPlus3 + yPlus6) * (x + 7)) / (y + 9)) / 256;
            }
        }

        this.towersGeometry.draw(this,
            this.towerObjectMats,
            this.towerObjectLightVectorMats,
            this.towerColorMultipliers,
            this.towerTexScrolls);
    }

    private fogTexScrolls: number[] = nArray(6, () => { return 0; });

    private drawOpeningFog() {
        for (let i = 0; i < 6; ++i) {
            this.fogTexScrolls[i] = (((14 - i) * 0.0001 * (i + 1) / 2) * this.drawStableState.frameCounter) % 1;
        }
        this.openingFogGeometry.draw(this, this.fogTexScrolls);
    }

    static readonly FLARE_HISTORY_LEN = 128;
    private flareTranslationBuf: vec3[] = nArray(NUM_FLARES * NUM_FLARE_OVERDRAWS, vec3.create);
    private flareTranslations: vec3[] = nArray(NUM_FLARES, vec3.create);
    private flareTranslationHistory: vec3[] = nArray(NUM_FLARES * BIOSScene.FLARE_HISTORY_LEN, vec3.create);
    private flareTranslationHistoryCur: number = 0;
    private flareHistoryLastFrame: number = 0;
    private flareHistoryNeedsInit: boolean = true;
    private flareLineSegs: vec3[] = nArray(NUM_FLARES * (BIOSScene.FLARE_HISTORY_LEN - 1) * 2, vec3.create);
    private flareLineColorSegs: vec4[] = nArray(NUM_FLARES * (BIOSScene.FLARE_HISTORY_LEN - 1) * 2, vec4.create);
    private flarePathPhase: number = 0;
    public cameraAspect: number = 1;

    static readonly FLARE_COLORS: vec4[] = [
        [32 / 128, 128 / 128, 0, 0],
        [128 / 128, 32 / 128, 64 / 128, 0],
        [128 / 128, 0, 0, 0],
        [64 / 128, 32 / 128, 128 / 128, 0],
    ];

    private drawOpeningFlares() {
        for (let i = 0; i < NUM_FLARES; ++i) {
            const x = Math.cos((this.drawStableState.frameCounter + this.flarePathPhase + i * 17) * 0.01 * (i + 10) * 0.1);
            const y = Math.sin((this.drawStableState.frameCounter + this.flarePathPhase + i * 15) * 0.005 * (i + 10) * 0.1);
            for (let o = 0; o < NUM_FLARE_OVERDRAWS; ++o) {
                const transIdx = i * NUM_FLARE_OVERDRAWS + o;
                if (o === NUM_FLARE_OVERDRAWS - 1) {
                    vec3.set(this.flareTranslations[i], (10 - i) * x, (i + 3) * y, x * 12 + 88);
                    vec3.copy(this.flareTranslationBuf[transIdx], this.flareTranslations[i]);
                } else {
                    const nextTransIdx = i * NUM_FLARE_OVERDRAWS + o + 1;
                    vec3.copy(this.flareTranslationBuf[transIdx], this.flareTranslationBuf[nextTransIdx]);
                }
            }
        }

        this.openingFlaresGeometry.draw(this, this.flareTranslationBuf, BIOSScene.FLARE_COLORS);

        if (this.flareHistoryLastFrame !== this.drawStableState.frameCounter >>> 0) {
            this.flareHistoryLastFrame = this.drawStableState.frameCounter >>> 0;

            // Update flare history buffer regulated by 60Hz frames.
            for (let i = 0; i < NUM_FLARES; ++i) {
                if (this.flareHistoryNeedsInit) {
                    for (let h = 0; h < BIOSScene.FLARE_HISTORY_LEN; ++h) {
                        const historyIdx = i * BIOSScene.FLARE_HISTORY_LEN + h;
                        vec3.copy(this.flareTranslationHistory[historyIdx], this.flareTranslations[i]);
                    }
                } else {
                    const historyIdx = i * BIOSScene.FLARE_HISTORY_LEN + this.flareTranslationHistoryCur;
                    vec3.copy(this.flareTranslationHistory[historyIdx], this.flareTranslations[i]);
                }

                const flareColor = BIOSScene.FLARE_COLORS[i];
                for (let h = 0; h < BIOSScene.FLARE_HISTORY_LEN - 1; ++h) {
                    const sourceIdx = (this.flareTranslationHistoryCur + 1 + h) % BIOSScene.FLARE_HISTORY_LEN;
                    const nextSourceIdx = (this.flareTranslationHistoryCur + 2 + h) % BIOSScene.FLARE_HISTORY_LEN;
                    const historyIdx = i * BIOSScene.FLARE_HISTORY_LEN + sourceIdx;
                    const nextHistoryIdx = i * BIOSScene.FLARE_HISTORY_LEN + nextSourceIdx;
                    const outIdx = (i * (BIOSScene.FLARE_HISTORY_LEN - 1) + h) * 2;
                    vec3.copy(this.flareLineSegs[outIdx], this.flareTranslationHistory[historyIdx]);
                    vec3.copy(this.flareLineSegs[outIdx + 1], this.flareTranslationHistory[nextHistoryIdx]);
                    vec4.copy(this.flareLineColorSegs[outIdx], flareColor);
                    this.flareLineColorSegs[outIdx][3] = h / BIOSScene.FLARE_HISTORY_LEN / 2;
                    vec4.copy(this.flareLineColorSegs[outIdx + 1], flareColor);
                    this.flareLineColorSegs[outIdx + 1][3] = (h + 1) / BIOSScene.FLARE_HISTORY_LEN / 2;
                }
            }

            this.flareTranslationHistoryCur = (this.flareTranslationHistoryCur + 1) % BIOSScene.FLARE_HISTORY_LEN;
            this.flareHistoryNeedsInit = false;
        } else {
            // For intermediate frames, use the latest translation on the final segment.
            for (let i = 0; i < NUM_FLARES; ++i) {
                const outIdx = (i * (BIOSScene.FLARE_HISTORY_LEN - 1) + BIOSScene.FLARE_HISTORY_LEN - 2) * 2;
                vec3.copy(this.flareLineSegs[outIdx + 1], this.flareTranslations[i]);
            }
        }

        this.linesGeometry.draw(this, this.flareLineSegs, this.flareLineColorSegs, this.cameraAspect);
    }

    private drawCubes() {
        this.multipassCubeGeometry.draw(this, this.drawStableState.frameCounter / 60);
    }

    private openingInit_0021e578() {
        this.fadeWarningTextOut = false;
    }

    private openingInitTextFade() {
        if (this.entryOverallOpeningState === OverallOpeningState.OpeningScreen) {
            this.sceTextState = TextFadingState.NotYetFading;
            this.warningTextState = TextFadingState.DoneFading;
        } else {
            this.sceTextState = TextFadingState.DoneFading;
            this.warningTextState = TextFadingState.NotYetFading;
        }
        this.tickStableState.sceTextAlpha = 0.0;
        this.sceTextAlpha_dx_dt = 4.0;
        this.tickStableState.warningTextAlpha = 0.0;
    }

    private openingInit() {
        this.overallOpeningState = this.entryOverallOpeningState;
        this.requestedOverallOpeningState = this.entryOverallOpeningState;
        this.openingInitAnimation();
        this.openingInitTowersFog();
        this.openingInit_0021e578();
        this.openingInitTextFade();
        this.frameCounter = 0;
    }

    private initCubes() {

    }

    private initLightsCubes() {
        this.initCubes();
        this.flarePathPhase = ((Math.random() * 0xffffffff) >>> 0) % 0x929 + 0xd80;
    }

    static normalLightMatrix(out: mat4, l0: vec3, l1: vec3, l2: vec3): mat4 {
        vec3.normalize(scratchVec, l0);
        out[0] = -scratchVec[0];
        out[4] = -scratchVec[1];
        out[8] = -scratchVec[2];
        out[12] = 0.0;
        vec3.normalize(scratchVec, l1);
        out[1] = -scratchVec[0];
        out[5] = -scratchVec[1];
        out[9] = -scratchVec[2];
        out[13] = 0.0;
        vec3.normalize(scratchVec, l2);
        out[2] = -scratchVec[0];
        out[6] = -scratchVec[1];
        out[10] = -scratchVec[2];
        out[14] = 0.0;
        out[3] = 0.0;
        out[7] = 0.0;
        out[11] = 0.0;
        out[15] = 1.0;
        return out;
    }

    static readonly LIGHT_VECTOR_0: vec3 = [0, 0, -1];
    static readonly LIGHT_VECTOR_1: vec3 = [0.5, 0.5, 0];
    static readonly LIGHT_VECTOR_2: vec3 = [-0.5, -0.5, 0];

    private initOpeningScene() {
        vec3.set(this.tickStableState.cameraPosition, 0, 0, 16);
        this.tickStableState.cameraRoll = -0.12;

        BIOSScene.normalLightMatrix(this.towerLightVectorMat, BIOSScene.LIGHT_VECTOR_0, BIOSScene.LIGHT_VECTOR_1, BIOSScene.LIGHT_VECTOR_2);
        vec3.set(this.eyeDirection, 0, 0, 1);
        vec3.set(this.eyeUpDirection, 0, 1, 0);

        this.initLightsCubes();
    }

    static readonly CAMERA_Z_STATE_THRESHOLDS = [
        16, 56, 104, 320, 672, 800, 1160, 1160
    ];

    private tickAnimation() {
        let newOverallOpeningState = this.overallOpeningState;

        if (this.tickStableState.cameraPosition[2] > BIOSScene.CAMERA_Z_STATE_THRESHOLDS[this.animationProcessingState]) {
            this.animationProcessingState += 1;
            console.log(`State ${this.animationProcessingState} at position ${this.tickStableState.cameraPosition[2]}`);
        }

        switch (this.animationProcessingState) {
            case AnimationProcessingState.One:
                // TODO: Boot ready logic
                this.cameraPosition_ddd[2] = 4e-07;
                break;
                this.cameraRoll_d = 0.0004;
                if (this.frameCounter < 20 * 60 / 6) {
                    this.cameraPosition_dd[2] = -0.00014;
                } else {
                    this.cameraPosition_dd[2] = 2.5e-05;
                }
                if (this.frameCounter > 3 * 60) {
                    this.animationProcessingState += 1;
                    this.cameraPosition_dd[2] = 0.003;
                }
                break;
            case AnimationProcessingState.Two:
                // TODO: Clock transition logic
                break;
            case AnimationProcessingState.Three:
                //newOverallOpeningState = this.overallOpeningState + 1;
                break;
            case AnimationProcessingState.Six:
                this.cameraRoll_dd = 0;
                vec3.zero(this.cameraPosition_d);
                vec3.zero(this.cameraPosition_dd);
                vec3.zero(this.cameraPosition_ddd);
                // TODO: Warning screen logic
                break;
            case AnimationProcessingState.Seven:
                newOverallOpeningState = OverallOpeningState.Done;
                this.openingInitAnimation();
                break;
            default:
                break;
        }

        this.cameraRoll_d += this.cameraRoll_dd;

        vec3.add(this.cameraPosition_d,
            this.cameraPosition_d,
            vec3.mul(scratchVec,
                vec3.add(scratchVec,
                    vec3.add(scratchVec,
                        this.cameraPosition_dd,
                        this.cameraPosition_dd),
                    this.cameraPosition_ddd),
                halfVec));

        this.cameraPosition_dd[2] += this.cameraPosition_ddd[2];

        this.tickStableState.cameraRoll += (this.cameraRoll_d + this.cameraRoll_d + this.cameraRoll_dd) * 0.5;

        vec3.add(this.tickStableState.cameraPosition,
            this.tickStableState.cameraPosition,
            vec3.mul(scratchVec,
                vec3.add(scratchVec,
                    vec3.add(scratchVec,
                        this.cameraPosition_d,
                        this.cameraPosition_d),
                    this.cameraPosition_dd),
                halfVec));

        if (this.tickStableState.cameraRoll > Math.PI) {
            this.tickStableState.cameraRoll -= Math.PI * 2;
        } else if (this.tickStableState.cameraRoll < -Math.PI) {
            this.tickStableState.cameraRoll += Math.PI * 2;
        }

        if (newOverallOpeningState !== this.overallOpeningState) {
            this.screenProcessingState = this.screenProcessingState += 1;
        }
    }

    private tickOpeningScreen() {
        if (this.screenProcessingState === ScreenProcessingState.NeedsInit) {
            this.initOpeningScene();
            this.screenProcessingState = ScreenProcessingState.NeedsUpdate;
        }

        if (this.screenProcessingState === ScreenProcessingState.NeedsUpdate) {
            this.tickOpeningTowers();
        } else if (this.screenProcessingState === ScreenProcessingState.Done) {
            this.requestedOverallOpeningState = OverallOpeningState.Done;
            this.screenProcessingState = ScreenProcessingState.NeedsInit;
        }
    }

    private drawOpeningScreen() {
        if (this.screenProcessingState === ScreenProcessingState.NeedsUpdate) {
            this.drawOpeningTowers();
            this.drawOpeningFog();
            this.drawOpeningFlares();
            this.drawCubes();
        }
    }

    private tickWarningScreen() {

    }

    private tickSCEText() {
        if (this.tickStableState.cameraPosition[2] > 18.0 && this.sceTextState === TextFadingState.NotYetFading) {
            this.sceTextState = TextFadingState.Fading;
        } else if (this.sceTextState !== TextFadingState.Fading) {
            return;
        }

        this.tickStableState.sceTextAlpha += this.sceTextAlpha_dx_dt;
        if (this.tickStableState.sceTextAlpha === 0xf0) {
            this.sceTextAlpha_dx_dt = -4;
        }
        if (this.tickStableState.sceTextAlpha === 0) {
            this.sceTextAlpha_dx_dt = 4;
            this.sceTextState = TextFadingState.DoneFading;
        }
    }

    private drawSCEText() {
        if (this.sceTextState !== TextFadingState.Fading) {
            return;
        }

        const alpha = Math.min(0x70, this.drawStableState.sceTextAlpha);
        //console.log(`Drawing SCE at ${alpha} alpha`);
    }

    private tickWarningText() {
        if (this.tickStableState.cameraPosition[2] > 800.0 && this.warningTextState === TextFadingState.NotYetFading) {
            this.warningTextState = TextFadingState.Fading;
        } else if (this.warningTextState !== TextFadingState.Fading) {
            return;
        }

        if (!this.fadeWarningTextOut) {
            this.tickStableState.warningTextAlpha += 1;
        } else if (this.tickStableState.warningTextAlpha > 0) {
            this.tickStableState.warningTextAlpha -= 1;
        }
    }

    private drawWarningText() {
        if (this.warningTextState !== TextFadingState.Fading) {
            return;
        }

        const alpha = Math.min(0x70, this.drawStableState.warningTextAlpha);
        //console.log(`Drawing warning at ${alpha} alpha`);
    }

    private tickTextFade() {
        this.tickSCEText();
        this.tickWarningText();
    }

    private drawTextFade() {
        this.drawSCEText();
        this.drawWarningText();
    }

    /**
     * The BIOS opening animation makes heavy use of third-order differentials
     * and state transitions which assume a fixed update cadence. Since noclip
     * cannot guarantee this, stableTick is called in a sub-ticking loop which
     * simulates a stable ticking at 60Hz.
     *
     * Make all stable state accesses through this.tickStableState.
     */
    private stableTick() {
        this.tickStableState.frameCounter = this.frameCounter;

        if (this.overallOpeningState === OverallOpeningState.InitForNoclip) {
            this.openingInit();
        }
        if (this.overallOpeningState === OverallOpeningState.Done) {
            return;
        }

        this.tickAnimation();

        if (this.overallOpeningState === OverallOpeningState.OpeningScreen) {
            this.tickOpeningScreen();
        } else if (this.overallOpeningState === OverallOpeningState.WarningScreen) {
            this.tickWarningScreen();
        }

        this.tickTextFade();

        this.overallOpeningState = this.requestedOverallOpeningState;
        this.frameCounter += 1;
    }

    /**
     * In the original, tick and draw were performed in the same call flow.
     * In noclip it's split into paired tick/draw functions. The previous
     * stable state is kept so the actual draw can present a linear
     * interpolation between two states and unlock the overall presentation
     * from 60Hz without disrupting the original behavior.
     *
     * Make all stable state accesses through this.drawStableState.
     */
    private stableDraw() {
        if (this.overallOpeningState === OverallOpeningState.Done) {
            return;
        }

        this.drawOpeningScreen();

        this.drawTextFade();

        // TODO: Letterbox
    }

    public tick(time: number) {
        if (this.lastStableTickTime === null) {
            this.stableTick();
            copyStableState(this.prevStableState, this.tickStableState);
            copyStableState(this.drawStableState, this.prevStableState);
            this.lastStableTickTime = time;
            return;
        }
        while (this.lastStableTickTime < time) {
            copyStableState(this.prevStableState, this.tickStableState);
            this.stableTick();
            this.lastStableTickTime += BIOSScene.STABLE_TICK_RATE;
        }
        this.interpolateDrawStableState(time);
    }

    private interpolateDrawStableState(time: number) {
        const lastStableTickTime = assertExists(this.lastStableTickTime);
        assert(time <= lastStableTickTime);

        const prevStableTickTime = lastStableTickTime - BIOSScene.STABLE_TICK_RATE;
        const alpha = clamp((time - prevStableTickTime) / BIOSScene.STABLE_TICK_RATE, 0.0, 1.0);

        interpolateStableState(this.drawStableState, this.prevStableState, this.tickStableState, alpha);
    }

    public updateCameraMatrix(cameraMatrix: mat4) {
        this.drawStableState.cameraRoll = 0;
        this.eyeUpDirection[0] = Math.sin(this.drawStableState.cameraRoll);
        this.eyeUpDirection[1] = Math.cos(this.drawStableState.cameraRoll);
        vec3.add(scratchVec, this.drawStableState.cameraPosition, this.eyeDirection);
        mat4.targetTo(cameraMatrix, this.drawStableState.cameraPosition, scratchVec, this.eyeUpDirection);
    }

    private draw() {
        this.stableDraw();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
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
        this.fillSceneParams(template, viewerInput);

        // This will update our uniforms and populate the inst lists.
        this.draw();

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');

        // Route text to the final on-screen pass for this frame.
        const textInCubePass = this.frontfaceCubeInstList.renderInsts.length !== 0;

        // Main on-screen pass (towers, fog, flares).
        builder.pushPass((pass) => {
            pass.setDebugName("Main Pass");
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer, scope) => {
                this.mainInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                if (!textInCubePass) {
                    this.textInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                }
            });
        });

        // The first five refractive cube passes are back faces.
        if (this.backfaceCubeInstList.renderInsts.length) {
            const sceneColorResolveTextureID = builder.resolveRenderTarget(mainColorTargetID);
            builder.pushPass((pass) => {
                pass.setDebugName("Back Face Cube Pass");
                pass.attachResolveTexture(sceneColorResolveTextureID);
                pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
                pass.exec((passRenderer, scope) => {
                    const sceneColorTexture = scope.getResolveTextureForID(sceneColorResolveTextureID);
                    this.backfaceCubeInstList.resolveLateSamplerBinding("sceneColor", {
                        gfxTexture: sceneColorTexture,
                        gfxSampler: this.clampSampler
                    });
                    this.backfaceCubeInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                });
            });
        }

        // The last five refractive cube passes are front faces.
        if (this.frontfaceCubeInstList.renderInsts.length) {
            const sceneColorResolveTextureID = builder.resolveRenderTarget(mainColorTargetID);
            builder.pushPass((pass) => {
                pass.setDebugName("Front Face Cube Pass");
                pass.attachResolveTexture(sceneColorResolveTextureID);
                pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
                pass.exec((passRenderer, scope) => {
                    const sceneColorTexture = scope.getResolveTextureForID(sceneColorResolveTextureID);
                    this.frontfaceCubeInstList.resolveLateSamplerBinding("sceneColor", {
                        gfxTexture: sceneColorTexture,
                        gfxSampler: this.clampSampler
                    });
                    this.frontfaceCubeInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                    if (textInCubePass) {
                        this.textInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                    }
                });
            });
        }

        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.debugDraw.pushPasses(builder, mainColorTargetID, mainDepthTargetID);
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);
        this.renderHelper.prepareToRender();
        builder.execute();
    }

    public createCameraController(): CameraController {
        return new BIOSCameraController(this);
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

        this.biosROM.destroy(device);

        this.osdSnd.stop().then(r => {});
    }
}

class OsdSysSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string) {
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
        new OsdSysSceneDesc("BIOS", "BIOS"),
    ],
};
