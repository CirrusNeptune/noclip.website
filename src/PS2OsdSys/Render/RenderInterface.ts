import {GfxRenderHelper} from "../../gfx/render/GfxRenderHelper";
import {GfxRenderInstList} from "../../gfx/render/GfxRenderInstManager";
import {GfxSampler} from "../../gfx/platform/GfxPlatformImpl";

export default interface RenderInterface {
    renderHelper: GfxRenderHelper;
    renderInstList: GfxRenderInstList;
    linearSampler: GfxSampler;
}
