import {GfxRenderHelper} from "../gfx/render/GfxRenderHelper";
import {GfxRenderInstList} from "../gfx/render/GfxRenderInstManager";
import {GfxSampler} from "../gfx/platform/GfxPlatformImpl";
import TowersGeometry from "./Render/Towers";
import OpeningFogGeometry from "./Render/OpeningFog";
import OpeningFlaresGeometry from "./Render/OpeningFlares";
import LinesGeometry from "./Render/Lines";
import MultipassCubeGeometry from "./Render/MultipassCube";
import {MCHistoryEntry} from "./MCHistory";

export default interface IBIOSScene {
    renderHelper: GfxRenderHelper;
    mainInstList: GfxRenderInstList;
    backfaceRefractInstList: GfxRenderInstList;
    frontfaceRefractInstList: GfxRenderInstList;
    textInstList: GfxRenderInstList;
    linearSampler: GfxSampler;

    towersGeometry: TowersGeometry;
    openingFogGeometry: OpeningFogGeometry;
    openingFlaresGeometry: OpeningFlaresGeometry;
    linesGeometry: LinesGeometry;
    multipassCubeGeometry: MultipassCubeGeometry;

    mcHistory: MCHistoryEntry[];
    cameraAspect: number;
}
