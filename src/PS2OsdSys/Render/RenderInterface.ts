import {GfxRenderHelper} from "../../gfx/render/GfxRenderHelper";
import {GfxRenderInstList} from "../../gfx/render/GfxRenderInstManager";
import {GfxSampler} from "../../gfx/platform/GfxPlatformImpl";

export default interface RenderInterface {
    renderHelper: GfxRenderHelper;
    mainInstList: GfxRenderInstList;
    backfaceCubeInstList: GfxRenderInstList;
    frontfaceCubeInstList: GfxRenderInstList;
    textInstList: GfxRenderInstList;
    linearSampler: GfxSampler;
}
