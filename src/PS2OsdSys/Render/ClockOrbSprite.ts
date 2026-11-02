import {
    GfxBuffer,
    GfxInputLayout,
    GfxProgram,
    type GfxTexture
} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBlendFactor,
    GfxBlendMode,
    GfxBufferFrequencyHint,
    GfxBufferUsage, GfxChannelWriteMask, GfxCompareMode,
    GfxCullMode, GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import {vec3, vec4} from "gl-matrix";
import {fillVec3v, fillVec4, fillVec4v} from "../../gfx/helpers/UniformBufferHelpers";
import IBIOSScene from "../IBIOSScene";
import {BIOSROM} from "../BIOSROM";
import {assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";
import {GfxRenderInstList} from "../../gfx/render/GfxRenderInstManager";

class ClockOrbSpriteProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_TexCoord = 1;

    public static ub_ClockOrbSpriteParams = 1;

    public override vert = `
${ClockOrbSpriteProgram.Common}

layout(location = ${ClockOrbSpriteProgram.a_Position}) in vec3 a_Position;
layout(location = ${ClockOrbSpriteProgram.a_TexCoord}) in vec2 a_TexCoord;

out vec3 v_Color;
out vec2 v_TexCoord;
out float v_Highlight;

void main() {
    vec4 t_FlarePosWorld = UnpackMatrix(u_ClipFromWorld) * vec4(u_FlarePos_CameraAspectCorrect.xyz, 1.0f);
    vec3 Delta = a_Position;
    Delta.x *= u_FlarePos_CameraAspectCorrect.w;
    t_FlarePosWorld.xyz += Delta;
    gl_Position = t_FlarePosWorld;
    if (gl_VertexID < 4) {
        // Color part
        v_Color = u_FlareColor.rgb;
        v_Highlight = 0.0;
    } else {
        // Highlight part
        v_Color = vec3(1.f);
        v_Highlight = 1.0;
    }
    v_TexCoord = a_TexCoord.xy;
}
`;

    public override frag = `
${ClockOrbSpriteProgram.Common}

in vec3 v_Color;
in vec2 v_TexCoord;
in float v_Highlight;

void main() {
    vec2 t_Sample = texture(SAMPLER_2D(u_Texture), v_TexCoord.xy).rg;
    float t_SelSample = v_Highlight != 0.0 ? t_Sample.g : t_Sample.r;
    gl_FragColor.rgb = t_SelSample * v_Color;
    gl_FragColor.a = 1.0;
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_ClockOrbSpriteParams {
    vec4 u_FlarePos_CameraAspectCorrect;
    vec4 u_FlareColor;
};

uniform sampler2D u_Texture;
`;

}

const NUM_VERTEX_FLOATS = 5;

export default class ClockOrbSpriteGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly orbTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new ClockOrbSpriteProgram());

        this.orbTexture = assertExists(biosROM.textures.get(ResourceID.TEXCORB)).gfxTexture;

        // Vertex data for flares, large outer color and small inner highlight
        const vertexData = new Float32Array(4 * 2 * NUM_VERTEX_FLOATS);
        vertexData.set([
            //   Quad 0 - Color
            //   X   Y   Z      U  V
            -30.0, -30.0, 0,      0.0, 0.0,
            30.0, -30.0, 0,      1.0, 0.0,
            -30.0,  30.0, 0,      0.0, 1.0,
            30.0,  30.0, 0,      1.0, 1.0,

            //   Quad 1 - Highlight
            //   X   Y   Z      U  V
            -4.5, -4.5, 0,    0.0, 0.0,
            4.5, -4.5, 0,    1.0, 0.0,
            -4.5,  4.5, 0,    0.0, 1.0,
            4.5,  4.5, 0,    1.0, 1.0,
        ]);

        this.indexCount = 2 * 6;
        const indexData = new Uint16Array(this.indexCount);

        for (let i = 0; i < 2; ++i) {
            const baseIndex = i * 4;
            indexData[i * 6] = baseIndex;
            indexData[i * 6 + 1] = baseIndex + 1;
            indexData[i * 6 + 2] = baseIndex + 2;
            indexData[i * 6 + 3] = baseIndex + 3;
            indexData[i * 6 + 4] = baseIndex + 2;
            indexData[i * 6 + 5] = baseIndex + 1;
        }

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "Clock Orb Sprite (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "Clock Orb Sprite (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: ClockOrbSpriteProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: ClockOrbSpriteProgram.a_TexCoord,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 3 * 4,
                    bufferIndex: 0,
                },
            ],
            vertexBufferDescriptors: [
                {
                    byteStride: NUM_VERTEX_FLOATS * 4,
                    frequency: GfxVertexBufferFrequency.PerVertex,
                },
            ],

            indexBufferFormat: GfxFormat.U16_R,
        });
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
    }

    public draw(biosScene: IBIOSScene, instList: GfxRenderInstList, flarePos: vec3, flareColor: vec4){
        const renderInst = biosScene.renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: this.orbTexture, gfxSampler: biosScene.linearSampler }
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);

        const orbParams = renderInst.allocateUniformBufferF32(
            ClockOrbSpriteProgram.ub_ClockOrbSpriteParams, 4 + 4);

        let offs = 0;
        offs += fillVec3v(orbParams, offs, flarePos, 1.0 / biosScene.cameraAspect);

        offs += fillVec4(orbParams, offs, flareColor[0] / 128, flareColor[1] / 128, flareColor[2] / 128, flareColor[3] / 128);

        renderInst.setMegaStateFlags({
            attachmentsState: [
                {
                    channelWriteMask: GfxChannelWriteMask.AllChannels,
                    rgbBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.SrcAlpha,
                        blendDstFactor: GfxBlendFactor.One
                    },
                    alphaBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.SrcAlpha,
                        blendDstFactor: GfxBlendFactor.One
                    }
                }
            ],
            cullMode: GfxCullMode.None,
            depthCompare: GfxCompareMode.Always,
            depthWrite: false,
        });

        instList.submitRenderInst(renderInst);
    }
}
