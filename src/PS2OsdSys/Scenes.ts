import {mat4, vec3} from "gl-matrix";
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

// When we want to load files or assets at runtime, what directory are these assets in?
// We're going to be loading data/Examples/mandrill.jpg from here later; pathBase is relative to the data/ directory.
const pathBase = `PS2OsdSys`;

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

function transferStableState(to: StableState, from: StableState) {
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

        this.scene.tick(this.sceneTime);
        if (!this.didInit) {
            this.scene.updateCameraMatrix(this.camera.worldMatrix);
            this.setKeyMoveSpeed(2);
            this.camera.setPerspective(0.4604391746, this.camera.aspect, 1, 65536);
            window.main.ui.viewerSettings.setupFromCamera(this, this.camera);
            this.didInit = true;
        }
        this.scene.updateCameraMatrix(this.camera.worldMatrix);
        //super.update(inputManager, dt, sceneTimeScale);
        this.camera.worldMatrixUpdated();
        //console.log(`${this.camera.worldMatrix[12]}, ${this.camera.worldMatrix[13]}, ${this.camera.worldMatrix[14]}`);

        // Set result to unchanged to prevent needless savestate creation during playback.
        return CameraUpdateResult.Unchanged;
    }
}

class BIOSScene implements SceneGfx, RenderInterface {
    public renderHelper: GfxRenderHelper;

    // The renderInstList contains all of the objects we'll draw every frame.
    public renderInstList = new GfxRenderInstList();

    // The sampler for our cube, and for post-processing.
    public linearSampler: GfxSampler;

    private towersGeometry: TowersGeometry;
    private openingFogGeometry: OpeningFogGeometry;

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

        // The GfxRenderHelper is a helper class that contains several helpers.
        this.renderHelper = new GfxRenderHelper(sceneContext.device, sceneContext);

        // The GfxRenderCache is a helper we have on the render helper, which can detect when
        // we're creating the same of an object, and return an existing one for us. We'll use
        // the cache for input layouts, for shader programs, and for samplers.
        // Note that objects created with the GfxRenderCache don't need to be destroyed, it
        // wil get destroyed automatically later.
        const cache = this.renderHelper.renderCache;

        this.towersGeometry = new TowersGeometry(cache, this.biosROM);
        this.openingFogGeometry = new OpeningFogGeometry(cache, this.biosROM);

        // Samplers define how exactly textures are sampled; in this case, we want linear filtering,
        // and we want UVs that are out of bounds to clamp rather than repeat.
        this.linearSampler = cache.createSampler({
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
        const data = template.allocateUniformBufferF32(BaseProgram.ub_SceneParams, 16);
        let offs = 0;
        offs += fillMatrix4x4(data, offs, viewerInput.camera.clipFromWorldMatrix);
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

    private towerCameraManhattans: number[] = nArray(NUM_TOWERS, () => { return 0; });
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
        let maxCameraToTowerManhattan = 0;
        for (let x = 0; x < TOWER_GRID_WIDTH; ++x) {
            for (let y = 0; y < TOWER_GRID_HEIGHT; ++y) {
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                const towerVector = this.towerGridTranslations[towerIdx];
                const towerCameraDelta = vec3.sub(scratchVec, towerVector, this.tickStableState.cameraPosition);
                const towerCameraManhattan = Math.abs(towerCameraDelta[0]) + Math.abs(towerCameraDelta[1]);
                this.towerCameraManhattans[towerIdx] = towerCameraManhattan;
                if (towerCameraManhattan > maxCameraToTowerManhattan) {
                    maxCameraToTowerManhattan = towerCameraManhattan + 1;
                }
            }
        }

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
            transferStableState(this.prevStableState, this.tickStableState);
            transferStableState(this.drawStableState, this.prevStableState);
            this.lastStableTickTime = time;
            return;
        }
        while (this.lastStableTickTime < time) {
            transferStableState(this.prevStableState, this.tickStableState);
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
        this.eyeUpDirection[0] = Math.sin(this.drawStableState.cameraRoll);
        this.eyeUpDirection[1] = Math.cos(this.drawStableState.cameraRoll);
        vec3.add(scratchVec, this.drawStableState.cameraPosition, this.eyeDirection);
        mat4.targetTo(cameraMatrix, this.drawStableState.cameraPosition, scratchVec, this.eyeUpDirection);
    }

    private draw() {
        this.stableDraw();
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        // noclip's framework will call your render function once per frame. The device will always be the same
        // as the device passed in through the sceneContext in the constructor. The renderInput provided contains
        // extra details about the frame, like the delta time, window size, and mouse location.

        // Set up debug drawing (we didn't use any debug drawing in this example, but you can try looking through
        // this.renderHelper.debugDraw.* for all the different kinds of objects you can draw. These can be incredibly
        // helpful when debugging issues!)
        this.renderHelper.debugDraw.beginFrame(viewerInput.camera.projectionMatrix, viewerInput.camera.viewMatrix, viewerInput.backbufferWidth, viewerInput.backbufferHeight);

        // Example of debug draws:
        // this.renderHelper.debugDraw.screenPrintText('Hello', Red);

        // noclip's render framework has two important components to understand.
        //
        // The first is GfxRenderInst; this is how noclip's framework describes draw calls. A GfxRenderInst is an object
        // with a shader, some uniform parameters, some textures, some vertices, and some fixed-function flags.
        //
        // You can submit GfxRenderInst's directly, but more likely, you'll want to make a lot of draw calls for different
        // objects, so there's also a GfxRenderInstList where you can compile a lot of them together, and then draw them
        // on a single render pass.
        //
        // The GfxRenderInst framework also has a template system which makes it easier to build a lot of draw calls that
        // share parameters. Templates are very convenient for setting scene-specific parameters since you only need to
        // set them on the template, once, and all draw calls will inherit them.

        // First, set up our objects. In this case, we only have the cube to render. We need to set up a "template"
        // render inst, which contains some default setup created by our render helper. This template will contain
        // defaults for all the other render insts we'll use.
        const template = this.renderHelper.pushTemplateRenderInst();

        // The first thing we must do is tell noclip the maximum number of uniform blocks and texture samplers we need.
        template.setBindingLayouts([
            { numSamplers: 1, numUniformBuffers: 2 },
        ]);

        // Fill in the ub_SceneParams uniform block. The viewerInput contains the viewer's camera.
        this.fillSceneParams(template, viewerInput);

        this.draw();
        //this.renderHelper.debugDraw.screenPrintText(`${this.drawStableState.cameraPosition[2]}`, Green);

        // We could manually configure render passes using device.createRenderPass(), but we have a helper to
        // make writing render pass logic easier called the render graph; our render helper has one of them.
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        // To do post-processing, we'll need to render our objects into an intermediate texture.
        // This makeBackbufferDescSimple function tells us to create these textures to be as large as the window,
        // with default settings, and to use the default clear colors.
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');

        //const towerFeedbackColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Tower Feedback Color');

        // Push our default pass. The function given to pushPass() is called immediately, this is just a convenient
        // way to structure our passes and code.
        builder.pushPass((pass) => {
            // Give the pass a debug name (helpful for error messages and debugging tools)
            pass.setDebugName("Opaque Objects");

            // Attach our color and depth buffer.
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);

            // Now configure what should happen when we render this pass; in this case, we want to render our
            // main object list, which contains our cube. This pass exec function won't be called now;
            // it will be called later during the builder.execute() below.
            pass.exec((passRenderer, scope) => {
                this.renderInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });

        // TODO: Blur pass

        // Remove our template that we pushed using pushTemplate() at the beginning of the function,
        // now that we've made all the render insts we need to.
        this.renderHelper.renderInstManager.popTemplate();

        // Actually draw any of our debug draws.
        this.renderHelper.debugDraw.pushPasses(builder, mainColorTargetID, mainDepthTargetID);

        // Push our standard antialiasing passes (this activates if the user has "FXAA" selected in Viewer Settings)
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);

        // Now send our main color target on the screen.
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        // Before we run, we need to tell the render helper to update some of the behind the scenes data...
        this.renderHelper.prepareToRender();

        // Execute!
        builder.execute();
    }

    public createCameraController(): CameraController {
        return new BIOSCameraController(this);
    }

    // noclip has a few different hooks it calls when the scene is constructed to hook into various parts
    // of its UI or rendering framework. When the scene is loaded, `createPanels()` is called, and the returned
    // panels are placed inside the list of panels on the left.
    public createPanels(): UI.Panel[] {
        // Create our settings panel.
        const renderSettingsPanel = new UI.Panel();
        renderSettingsPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderSettingsPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Settings');

        return [renderSettingsPanel];
    }

    public destroy(device: GfxDevice): void {
        // noclip's framework will call this destroy function when the user navigates away from your scene.
        // Destroy any graphics resources or do any cleanup logic you need to here.
        this.renderHelper.destroy();
        this.towersGeometry.destroy(device);
        this.openingFogGeometry.destroy(device);

        this.biosROM.destroy(device);

        this.osdSnd.stop().then(r => {});
    }
}

// The SceneDesc needs an ID, a name, and a createScene function.
// The SceneDesc's ID is used to identify the scene by URL; keep this stable so that users can bookmark your scene!
// The SceneDesc's name is the name shown on the right side of the scene picker.
class OsdSysSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, sceneContext: SceneContext): Promise<SceneGfx> {
        // Start the BIOS loading (async)
        const biosBuffer = await sceneContext.dataFetcher.fetchData(`${pathBase}/SCPH-70004_BIOS_V12_PAL_200.BIN`);
        return new BIOSScene(sceneContext, new BIOSROM(biosBuffer, sceneContext.device));
    }
}

// The SceneGroup is your entry point; it's how noclip's UI displays all of the available scenes in its menu,
// and knows to pass control to your code.
//
// A SceneGroup usually corresponds to a single game, and the SceneDescs are the levels inside.
export const sceneGroup: SceneGroup = {
    // The SceneGroup's ID is used to identify the scene by URL. Much like the SceneDesc ID,
    // keep this stable so that users can bookmark your scene!
    id: "PS2Bios",
    // The SceneGroup's name is shown in the UI, on the left side of the scene picker.
    name: "PS2 Bios",

    // The list of SceneDecs shows up on the right side of the scene picker.
    sceneDescs: [
        // You can add strings into the sceneDescs array in order to add grouping to your scenes.
        // "Examples",
        new OsdSysSceneDesc("BIOS", "BIOS"),
    ],
};
