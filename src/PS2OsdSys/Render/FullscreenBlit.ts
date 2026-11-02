import {GfxProgram} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {GfxBlendFactor, GfxBlendMode, GfxChannelWriteMask, GfxDevice,} from "../../gfx/platform/GfxPlatform";
import IBIOSScene from "../IBIOSScene";
import {GfxRenderInst} from "../../gfx/render/GfxRenderInstManager";
import {DeviceProgram} from "../../Program";
import {GfxShaderLibrary} from "../../gfx/helpers/GfxShaderLibrary";
import {vec4} from "gl-matrix";
import {fullscreenMegaState, makeMegaState} from "../../gfx/helpers/GfxMegaStateDescriptorHelpers";
import {fillVec4v} from "../../gfx/helpers/UniformBufferHelpers";

class FullscreenBlitProgram extends DeviceProgram {
    public override vert = GfxShaderLibrary.fullscreenVS;
    public override frag = `
layout(std140) uniform ub_BlitParams {
    vec4 u_ModRGBA;
};

uniform sampler2D u_Texture;
in vec2 v_TexCoord;

void main() {
    gl_FragColor = texture(SAMPLER_2D(u_Texture), v_TexCoord) * u_ModRGBA;
}
`;
}

export default class FullscreenBlitGeometry {
    private readonly gfxProgram: GfxProgram;

    constructor(cache: GfxRenderCache) {
        this.gfxProgram = cache.createProgram(new FullscreenBlitProgram());
    }

    public destroy(device: GfxDevice): void {
    }

    public draw(biosScene: IBIOSScene, renderInst: GfxRenderInst, modColor: vec4, additive: boolean){
        renderInst.setUniformBuffer(biosScene.renderHelper.uniformBuffer);
        renderInst.setAllowSkippingIfPipelineNotReady(false);

        renderInst.setMegaStateFlags(makeMegaState({
            attachmentsState: [
                {
                    channelWriteMask: GfxChannelWriteMask.AllChannels,
                    rgbBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.One,
                        blendDstFactor: additive ? GfxBlendFactor.One : GfxBlendFactor.Zero
                    },
                    alphaBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.One,
                        blendDstFactor: GfxBlendFactor.Zero
                    }
                }
            ],
        }, fullscreenMegaState));
        renderInst.setBindingLayouts([{ numUniformBuffers: 1, numSamplers: 1 }]);
        renderInst.setDrawCount(3);

        renderInst.setGfxProgram(this.gfxProgram);

        const blitParams = renderInst.allocateUniformBufferF32(0, 4);
        fillVec4v(blitParams, 0, modColor);
    }
}
