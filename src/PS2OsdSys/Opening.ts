import {mat4, vec3, vec4} from "gl-matrix";
import {nArray} from "../util";
import {CubeParams, NUM_CUBES} from "./Render/MultipassCube";
import {clamp, lerp, MathConstants, setMatrixTranslation} from "../MathHelpers";
import {lerpAngleVec3, normalizeAngleVec3, normalLightMatrix, zeroMatrix} from "./Util";
import {NUM_TOWERS, TOWER_GRID_HEIGHT, TOWER_GRID_WIDTH} from "./Render/Towers";
import {NUM_HISTORY_SLOTS} from "./MCHistory";
import IBIOSScene from "./IBIOSScene";
import {NUM_FLARE_OVERDRAWS, NUM_FLARES} from "./Render/OpeningFlares";
import {BIOSModule, StableStateOps} from "./BIOSModule";

const scratchVec: vec3 = vec3.create();
const halfVec: vec3 = vec3.fromValues(0.5, 0.5, 0.5);

export enum OverallOpeningState {
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

const TOWER_GRID_BASE_TRANSLATIONS: number[] = [
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

const TOWER_GRID_COORDINATE_ALLOCATION_TABLE: number[] = [
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

const BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1: number[] = [
    0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0
];

const BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2: number[] = [
    0.2, 0.4, 0.6, 0.8, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
];

const FLARE_COLORS: vec4[] = [
    [32 / 128, 128 / 128, 0, 0],
    [128 / 128, 32 / 128, 64 / 128, 0],
    [128 / 128, 0, 0, 0],
    [64 / 128, 32 / 128, 128 / 128, 0],
];

const FLARE_HISTORY_LEN = 128;

const CUBE_BASE_TRANSLATIONS: number[] = [
    35679 / 10000, 5447 / 10000, 25932 / 10000,
    -9042 / 10000, -11173 / 10000, 37952 / 10000,
    32639 / 10000, -26491 / 10000, 41075 / 10000,
    -37296 / 10000, -23677 / 10000, 43654 / 10000,
    -31017 / 10000, 22409 / 10000, 45429 / 10000,
];

const CUBE_COLOR_BIAS: vec3 = [-16, -16, 24];

const LIGHT_VECTOR_0: vec3 = [0, 0, -1];
const LIGHT_VECTOR_1: vec3 = [0.5, 0.5, 0];
const LIGHT_VECTOR_2: vec3 = [-0.5, -0.5, 0];

const CAMERA_Z_STATE_THRESHOLDS: number[] = [
    16, 56, 104, 320, 672, 800, 1160, 1160
];

/**
 * Any animated variables directly used in drawing should be kept here
 * and linear interpolated with the previous to resolve the stable tick results
 */
interface StableState {
    frameCounter: number,
    cameraPosition: vec3,
    cameraRoll: number,
    cubeRotations: vec3[],
    cubeTranslations: vec3[],
    sceTextAlpha: number,
    warningTextAlpha: number,
}

const STABLE_STATE_OPS: StableStateOps<StableState> = {
    makeStableState: () => {
        return {
            frameCounter: 0,
            cameraPosition: vec3.create(),
            cameraRoll: 0,
            cubeRotations: nArray(NUM_CUBES, vec3.create),
            cubeTranslations: nArray(NUM_CUBES, vec3.create),
            sceTextAlpha: 0,
            warningTextAlpha: 0,
        };
    },

    copyStableState: (to: StableState, from: StableState) => {
        to.frameCounter = from.frameCounter;
        vec3.copy(to.cameraPosition, from.cameraPosition);
        to.cameraRoll = from.cameraRoll;
        for (let i = 0; i < NUM_CUBES; ++i) {
            vec3.copy(to.cubeRotations[i], from.cubeRotations[i]);
            vec3.copy(to.cubeTranslations[i], from.cubeTranslations[i]);
        }
        to.sceTextAlpha = from.sceTextAlpha;
        to.warningTextAlpha = from.warningTextAlpha;
    },

    interpolateStableState: (out: StableState, a: StableState, b: StableState, alpha: number) => {
        out.frameCounter = lerp(a.frameCounter, b.frameCounter, alpha);
        vec3.lerp(out.cameraPosition, a.cameraPosition, b.cameraPosition, alpha);
        out.cameraRoll = lerp(a.cameraRoll, b.cameraRoll, alpha);
        for (let i = 0; i < NUM_CUBES; ++i) {
            lerpAngleVec3(out.cubeRotations[i], a.cubeRotations[i], b.cubeRotations[i], alpha);
            vec3.lerp(out.cubeTranslations[i], a.cubeTranslations[i], b.cubeTranslations[i], alpha);
        }
        out.sceTextAlpha = lerp(a.sceTextAlpha, b.sceTextAlpha, alpha);
        out.warningTextAlpha = lerp(a.warningTextAlpha, b.warningTextAlpha, alpha);
    }
};

export class OpeningModule extends BIOSModule<StableState> {
    private frameCounter: number = 0;
    private entryOverallOpeningState = OverallOpeningState.OpeningScreen;
    private overallOpeningState: OverallOpeningState = OverallOpeningState.OpeningScreen;
    private requestedOverallOpeningState: OverallOpeningState = OverallOpeningState.OpeningScreen;
    private screenProcessingState: ScreenProcessingState = ScreenProcessingState.NeedsInit;
    private animationProcessingState: AnimationProcessingState = AnimationProcessingState.Zero;
    private sceTextState: TextFadingState = TextFadingState.DoneFading;
    private warningTextState: TextFadingState = TextFadingState.DoneFading;

    private cubeRotations_d: vec3[] = nArray(NUM_CUBES, vec3.create);

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

    private openingInitTowersFog() {
        for (let i = 0; i < NUM_TOWERS; ++i) {
            this.towerEnabled[i] = false;
        }

        for (let historyIdx = 0; historyIdx < NUM_HISTORY_SLOTS; ++historyIdx) {
            const history = this.biosScene.mcHistory[historyIdx];
            if (!history.allocated) {
                continue;
            }

            for (let histTowerIdx = 0; histTowerIdx < 6; ++histTowerIdx) {
                const coordTableIdx = historyIdx * (2*6) + histTowerIdx * 2;
                const x = TOWER_GRID_COORDINATE_ALLOCATION_TABLE[coordTableIdx];
                const y = TOWER_GRID_COORDINATE_ALLOCATION_TABLE[coordTableIdx + 1];
                const towerIdx = x * TOWER_GRID_HEIGHT + y;
                if (history.lastSetProgressBit === histTowerIdx) {
                    if (history.launchCount < 14) {
                        this.towerGridZDisplacements1[towerIdx] = BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1[history.launchCount];
                        this.towerGridZDisplacements2[towerIdx] = BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2[history.launchCount];
                    } else {
                        const modLaunchCount = (history.launchCount - 14) % 10 + 4;
                        this.towerGridZDisplacements1[towerIdx] = BASE_TOWER_VERTEX_Z_DISPLACEMENTS_1[modLaunchCount];
                        this.towerGridZDisplacements2[towerIdx] = BASE_TOWER_VERTEX_Z_DISPLACEMENTS_2[modLaunchCount];
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
                translation[0] = (TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3] + 4.8) * 4;
                translation[1] = (TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3 + 1] - 6.5) * 4;
                translation[2] = (TOWER_GRID_BASE_TRANSLATIONS[towerIdx * 3 + 2] + 4) * 12 + 150;
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

        this.biosScene.towersGeometry.draw(
            this.biosScene,
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
        this.biosScene.openingFogGeometry.draw(this.biosScene, this.fogTexScrolls);
    }

    private flareTranslationBuf: vec3[] = nArray(NUM_FLARES * NUM_FLARE_OVERDRAWS, vec3.create);
    private flareTranslations: vec3[] = nArray(NUM_FLARES, vec3.create);
    private flareTranslationHistory: vec3[] = nArray(NUM_FLARES * FLARE_HISTORY_LEN, vec3.create);
    private flareTranslationHistoryCur: number = 0;
    private flareHistoryLastFrame: number = 0;
    private flareHistoryNeedsInit: boolean = true;
    private flareLineSegs: vec3[] = nArray(NUM_FLARES * (FLARE_HISTORY_LEN - 1) * 2, vec3.create);
    private flareLineColorSegs: vec4[] = nArray(NUM_FLARES * (FLARE_HISTORY_LEN - 1) * 2, vec4.create);
    private flarePathPhase: number = 0;

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

        this.biosScene.openingFlaresGeometry.draw(this.biosScene, this.flareTranslationBuf, FLARE_COLORS);

        if (this.flareHistoryLastFrame !== this.drawStableState.frameCounter >>> 0) {
            this.flareHistoryLastFrame = this.drawStableState.frameCounter >>> 0;

            // Update flare history buffer regulated by 60Hz frames.
            for (let i = 0; i < NUM_FLARES; ++i) {
                if (this.flareHistoryNeedsInit) {
                    for (let h = 0; h < FLARE_HISTORY_LEN; ++h) {
                        const historyIdx = i * FLARE_HISTORY_LEN + h;
                        vec3.copy(this.flareTranslationHistory[historyIdx], this.flareTranslations[i]);
                    }
                } else {
                    const historyIdx = i * FLARE_HISTORY_LEN + this.flareTranslationHistoryCur;
                    vec3.copy(this.flareTranslationHistory[historyIdx], this.flareTranslations[i]);
                }

                const flareColor = FLARE_COLORS[i];
                for (let h = 0; h < FLARE_HISTORY_LEN - 1; ++h) {
                    const sourceIdx = (this.flareTranslationHistoryCur + 1 + h) % FLARE_HISTORY_LEN;
                    const nextSourceIdx = (this.flareTranslationHistoryCur + 2 + h) % FLARE_HISTORY_LEN;
                    const historyIdx = i * FLARE_HISTORY_LEN + sourceIdx;
                    const nextHistoryIdx = i * FLARE_HISTORY_LEN + nextSourceIdx;
                    const outIdx = (i * (FLARE_HISTORY_LEN - 1) + h) * 2;
                    vec3.copy(this.flareLineSegs[outIdx], this.flareTranslationHistory[historyIdx]);
                    vec3.copy(this.flareLineSegs[outIdx + 1], this.flareTranslationHistory[nextHistoryIdx]);
                    vec4.copy(this.flareLineColorSegs[outIdx], flareColor);
                    this.flareLineColorSegs[outIdx][3] = h / FLARE_HISTORY_LEN / 2;
                    vec4.copy(this.flareLineColorSegs[outIdx + 1], flareColor);
                    this.flareLineColorSegs[outIdx + 1][3] = (h + 1) / FLARE_HISTORY_LEN / 2;
                }
            }

            this.flareTranslationHistoryCur = (this.flareTranslationHistoryCur + 1) % FLARE_HISTORY_LEN;
            this.flareHistoryNeedsInit = false;
        } else {
            // For intermediate frames, use the latest translation on the final segment.
            for (let i = 0; i < NUM_FLARES; ++i) {
                const outIdx = (i * (FLARE_HISTORY_LEN - 1) + FLARE_HISTORY_LEN - 2) * 2;
                vec3.copy(this.flareLineSegs[outIdx + 1], this.flareTranslations[i]);
            }
        }

        this.biosScene.linesGeometry.draw(this.biosScene, this.flareLineSegs, this.flareLineColorSegs);
    }

    private tickCubes() {
        for (let i = 0; i < NUM_CUBES; ++i) {
            const cubeRotation = this.tickStableState.cubeRotations[i];
            vec3.add(cubeRotation, cubeRotation, this.cubeRotations_d[i]);
            normalizeAngleVec3(cubeRotation, cubeRotation);
        }
    }

    private drawCubes() {
        const params: CubeParams = {
            cubeRotations: this.drawStableState.cubeRotations,
            cubeTranslations: this.drawStableState.cubeTranslations,
            cubeExtent: 1.8,
            colorBias: CUBE_COLOR_BIAS,
        };
        this.biosScene.multipassCubeGeometry.draw(this.biosScene, params);
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

    private openingInit(openingState: OverallOpeningState) {
        this.entryOverallOpeningState = openingState;
        this.overallOpeningState = openingState;
        this.requestedOverallOpeningState = openingState;
        this.openingInitAnimation();
        this.openingInitTowersFog();
        this.openingInit_0021e578();
        this.openingInitTextFade();
        this.frameCounter = 0;
    }

    private initLightsCubes() {
        for (let i = 0; i < NUM_CUBES; ++i) {
            const rotationRateOut = this.cubeRotations_d[i];
            const rotationOut = this.tickStableState.cubeRotations[i];
            const translationOut = this.tickStableState.cubeTranslations[i];

            translationOut[0] = CUBE_BASE_TRANSLATIONS[i * 3] * 3.5;
            translationOut[1] = CUBE_BASE_TRANSLATIONS[i * 3 + 1] * 3.5;
            translationOut[2] = CUBE_BASE_TRANSLATIONS[i * 3 + 2] * -15.0 + 150.0;

            let fVar12 = (i + -2) * 0.8;
            if (fVar12 === 0.0) {
                fVar12 = 0.9;
            }
            const iVar9 = i % 3;
            const fVar10 = fVar12 * iVar9 * 3.7 + Math.PI / 11.0;

            rotationRateOut[0] = 0.0031 / fVar12;
            rotationRateOut[1] = fVar12 * 0.0022;
            rotationRateOut[2] = fVar12 / 1000.0 + 0.0013;

            rotationOut[0] = fVar10;
            rotationOut[1] = fVar10;
            rotationOut[2] = fVar10;
        }

        this.flarePathPhase = ((Math.random() * 0xffffffff) >>> 0) % 0x929 + 0xd80;
    }

    private initOpeningScene() {
        vec3.set(this.tickStableState.cameraPosition, 0, 0, 16);
        this.tickStableState.cameraRoll = -0.12;

        normalLightMatrix(this.towerLightVectorMat, LIGHT_VECTOR_0, LIGHT_VECTOR_1, LIGHT_VECTOR_2);
        vec3.set(this.eyeDirection, 0, 0, 1);
        vec3.set(this.eyeUpDirection, 0, 1, 0);

        this.initLightsCubes();
    }

    private tickAnimation() {
        let newOverallOpeningState = this.overallOpeningState;

        if (this.tickStableState.cameraPosition[2] > CAMERA_Z_STATE_THRESHOLDS[this.animationProcessingState]) {
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
            this.tickCubes();
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

    protected stableTick() {
        this.tickStableState.frameCounter = this.frameCounter;

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

    public draw() {
        if (this.overallOpeningState === OverallOpeningState.Done) {
            return;
        }

        this.drawOpeningScreen();

        this.drawTextFade();

        // TODO: Letterbox
    }

    public updateCameraMatrix(cameraMatrix: mat4, roll: boolean) {
        this.eyeUpDirection[0] = Math.sin(this.drawStableState.cameraRoll);
        this.eyeUpDirection[1] = Math.cos(this.drawStableState.cameraRoll);
        vec3.add(scratchVec, this.drawStableState.cameraPosition, this.eyeDirection);
        mat4.targetTo(cameraMatrix, this.drawStableState.cameraPosition, scratchVec, roll ? this.eyeUpDirection : [0, 1, 0]);
    }

    constructor(biosScene: IBIOSScene, openingState: OverallOpeningState) {
        super(biosScene, STABLE_STATE_OPS);
        this.openingInit(openingState);
    }
}
