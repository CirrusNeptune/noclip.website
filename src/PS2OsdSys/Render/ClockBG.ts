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
import {vec3} from "gl-matrix";
import {fillVec4} from "../../gfx/helpers/UniformBufferHelpers";
import IBIOSScene from "../IBIOSScene";
import {BIOSROM} from "../BIOSROM";
import {assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";
import {GfxRenderInstList} from "../../gfx/render/GfxRenderInstManager";
import {MathConstants} from "../../MathHelpers";

class ClockBGProgram extends BaseProgram {
    public static a_UnitXY = 0;
    public static a_UnitTheta = 1;
    public static a_Radius = 2;

    public static ub_ClockBGParams = 1;

    public override vert = `
${ClockBGProgram.Common}

layout(location = ${ClockBGProgram.a_UnitXY}) in vec2 a_UnitXY;
layout(location = ${ClockBGProgram.a_UnitTheta}) in float a_UnitTheta;
layout(location = ${ClockBGProgram.a_Radius}) in float a_Radius;

out vec3 v_Color;
out vec2 v_TexCoord;

#define BASE_RADIUS 6000.f
#define INT16_TO_TAU (${MathConstants.TAU} / 65536.f)

void main() {
    vec3 t_BiasRGB = u_BiasRGB_ScrollAnim.rgb;
    float t_ScrollAnim = u_BiasRGB_ScrollAnim.w;

    float t_DistScale = sin((t_ScrollAnim * 100.f + a_Radius * float(0x1400)) * INT16_TO_TAU) / 20.f + 1.f;
    vec3 t_Position = vec3(
        BASE_RADIUS * a_UnitXY.x * t_DistScale,
        BASE_RADIUS * a_UnitXY.y * t_DistScale,
        a_Radius * 1250.f - 2500.f
    );
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_Position, 1.0f);

    float t_ColorMod = (a_UnitXY.y + 1.f) * 10.f;
    float t_RevRadius = 32.f - a_Radius;
    float t_ColorRadius = t_RevRadius * t_RevRadius * t_RevRadius / 1024.f;
    v_Color = vec3(
        (t_ColorRadius * 230.f / 32.f + t_BiasRGB.r + t_ColorMod) / 128.f,
        (t_ColorRadius * 260.f / 32.f + t_BiasRGB.g + t_ColorMod) / 128.f,
        (t_ColorRadius * 260.f / 32.f + t_BiasRGB.b + t_ColorMod) / 128.f
    );

    v_TexCoord = vec2(
        a_UnitTheta * 3.f,
        (a_Radius / 32.f + mod(t_ScrollAnim, 5000.f) / 5000.f) * 3.f
    );
}
`;

    public override frag = `
${ClockBGProgram.Common}

in vec3 v_Color;
in vec2 v_TexCoord;

void main() {
    gl_FragColor.rgb = v_Color.rgb * texture(SAMPLER_2D(u_Texture), v_TexCoord.xy).rgb;
    gl_FragColor.a = 1.f;
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_ClockBGParams {
    vec4 u_BiasRGB_ScrollAnim;
};

uniform sampler2D u_Texture;
`;

}

const NUM_SLICES = 16;
const NUM_QUADS = 33;
const NUM_VERTEX_FLOATS = 4;

export default class ClockBGGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly bgTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new ClockBGProgram());

        this.bgTexture = assertExists(biosROM.textures.get(ResourceID.TEXCKABE)).gfxTexture;

        // Vertex data BG pie slices (16 slices of 33 radial quads)
        // Format: (unitX, unitY, theta, radius)
        const vertexData = new Float32Array((NUM_SLICES + 1) * (NUM_QUADS + 1) * NUM_VERTEX_FLOATS);

        for (let slice = 0; slice <= NUM_SLICES; ++slice) {
            const unitTheta = slice * 0x1000 / 0x10000;
            const theta = unitTheta * MathConstants.TAU;
            const unitX = Math.sin(theta);
            const unitY = Math.cos(theta);
            const baseSliceVert = slice * (NUM_QUADS + 1) * NUM_VERTEX_FLOATS;
            for (let radius = 0; radius <= NUM_QUADS; ++radius) {
                const baseVert = baseSliceVert + radius * NUM_VERTEX_FLOATS;
                if (radius === NUM_QUADS) {
                    vertexData[baseVert] = 0;
                    vertexData[baseVert + 1] = 0;
                } else {
                    vertexData[baseVert] = unitX;
                    vertexData[baseVert + 1] = unitY;
                }
                vertexData[baseVert + 2] = unitTheta;
                vertexData[baseVert + 3] = radius;
            }
        }

        this.indexCount = NUM_QUADS * NUM_SLICES * 6;
        const indexData = new Uint16Array(this.indexCount);

        for (let slice = 0; slice < NUM_SLICES; ++slice) {
            const leftBase = slice * (NUM_QUADS + 1);
            const rightBase = (slice + 1) * (NUM_QUADS + 1);
            for (let quad = 0; quad < NUM_QUADS; ++quad) {
                const sliceQuad = slice * NUM_QUADS + quad;
                indexData[sliceQuad * 6] = leftBase + quad;
                indexData[sliceQuad * 6 + 1] = rightBase + quad + 1;
                indexData[sliceQuad * 6 + 2] = leftBase + quad + 1;
                indexData[sliceQuad * 6 + 3] = rightBase + quad + 1;
                indexData[sliceQuad * 6 + 4] = leftBase + quad;
                indexData[sliceQuad * 6 + 5] = rightBase + quad;
            }
        }

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "ClockBG (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "ClockBG (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: ClockBGProgram.a_UnitXY,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: ClockBGProgram.a_UnitTheta,
                    format: GfxFormat.F32_R,
                    bufferByteOffset: 2 * 4,
                    bufferIndex: 0,
                },
                {
                    location: ClockBGProgram.a_Radius,
                    format: GfxFormat.F32_R,
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

    public draw(biosScene: IBIOSScene,
                instList: GfxRenderInstList,
                bgColorBias: vec3,
                bgScrollAnim: number){
        const renderInst = biosScene.renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: this.bgTexture, gfxSampler: biosScene.linearSampler }
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);

        const clockBGParams = renderInst.allocateUniformBufferF32(
            ClockBGProgram.ub_ClockBGParams, 4);
        fillVec4(clockBGParams, 0, bgColorBias[0], bgColorBias[1], bgColorBias[2], bgScrollAnim);

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
