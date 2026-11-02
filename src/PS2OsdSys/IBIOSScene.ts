import {GfxRenderHelper} from "../gfx/render/GfxRenderHelper";
import {GfxSampler} from "../gfx/platform/GfxPlatformImpl";
import TowersGeometry from "./Render/Towers";
import OpeningFogGeometry from "./Render/OpeningFog";
import OpeningFlaresGeometry from "./Render/OpeningFlares";
import LinesGeometry from "./Render/Lines";
import MultipassCubeGeometry from "./Render/MultipassCube";
import {MCHistoryEntry} from "./MCHistory";
import ClockBGGeometry from "./Render/ClockBG";
import ClockCrystalGeometry from "./Render/ClockCrystal";
import FullscreenBlitGeometry from "./Render/FullscreenBlit";
import ClockOrbSpriteGeometry from "./Render/ClockOrbSprite";

export default interface IBIOSScene {
    renderHelper: GfxRenderHelper;
    linearSampler: GfxSampler;
    clampSampler: GfxSampler;

    towersGeometry: TowersGeometry;
    openingFogGeometry: OpeningFogGeometry;
    openingFlaresGeometry: OpeningFlaresGeometry;
    linesGeometry: LinesGeometry;
    multipassCubeGeometry: MultipassCubeGeometry;
    clockBGGeometry: ClockBGGeometry;
    clockCrystalGeometry: ClockCrystalGeometry;
    clockOrbSpriteGeometry: ClockOrbSpriteGeometry;
    fullscreenBlitGeometry: FullscreenBlitGeometry;

    mcHistory: MCHistoryEntry[];
    cameraAspect: number;
}
