import {DeviceProgram} from "../../Program";
import {GfxShaderLibrary} from "../../gfx/helpers/GfxShaderLibrary";

export class BaseProgram extends DeviceProgram {
    // All our programs have this
    public static ub_SceneParams = 0;

    public static BaseCommon = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ClipFromWorld;
    Mat4x4 u_ViewFromWorld;
};`;
}
