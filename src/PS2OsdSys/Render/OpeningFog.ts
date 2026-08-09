import {GfxBuffer, GfxInputLayout, GfxProgram, GfxTexture} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {clamp} from "../../MathHelpers";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBlendFactor,
    GfxBlendMode,
    GfxBufferFrequencyHint,
    GfxBufferUsage,
    GfxChannelWriteMask,
    GfxCullMode,
    GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import RenderInterface from "./RenderInterface";
import {BaseProgram} from "./Base";
import {assert, assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BIOSROM} from "../BIOSROM";

class OpeningFogProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_TexCoord = 1;
    public static a_Color = 2;

    public static ub_OpeningFogParams = 1;

    public override vert = `
${OpeningFogProgram.Common}

layout(location = ${OpeningFogProgram.a_Position}) in vec3 a_Position;
layout(location = ${OpeningFogProgram.a_TexCoord}) in vec2 a_TexCoord;
layout(location = ${OpeningFogProgram.a_Color}) in vec4 a_Color;

out vec2 v_TexCoord;
out vec4 v_Color;
flat out int v_TexIndex;

void main() {
    vec3 Position = a_Position.xyz;
    Position.z -= float(gl_InstanceID * 5);
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(Position.xyz, 1.0f);
    v_TexCoord = a_TexCoord.xy;
    v_TexCoord.y -= u_TexScroll[gl_InstanceID / 4][gl_InstanceID % 4];
    v_Color = a_Color;
    v_TexIndex = gl_InstanceID % 3;
}
`;

    public override frag = `
${OpeningFogProgram.Common}

in vec2 v_TexCoord;
in vec4 v_Color;
flat in int v_TexIndex;

void main() {
    vec4 TexSample = vec4(0);
    switch (v_TexIndex) {
    case 0:
        TexSample = texture(SAMPLER_2D(u_Texture0), v_TexCoord.xy);
        break;
    case 1:
        TexSample = texture(SAMPLER_2D(u_Texture1), v_TexCoord.xy);
        break;
    case 2:
        TexSample = texture(SAMPLER_2D(u_Texture2), v_TexCoord.xy);
        break;
    }
    vec4 Color = TexSample * v_Color;
    Color = Color * (20.f / 128.f);
    gl_FragColor = vec4(Color.rgb, 1.0);
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_OpeningFogParams {
    vec4 u_TexScroll[2];
};

layout(binding = 0) uniform sampler2D u_Texture0;
layout(binding = 1) uniform sampler2D u_Texture1;
layout(binding = 2) uniform sampler2D u_Texture2;
`;

}

const PASS_TEXTURE_IDS = [
    ResourceID.TEXOFOG4,
    ResourceID.TEXOFOG2,
    ResourceID.TEXOFOG1,
];

export const NUM_FOG_INSTANCES = 6;
const GRID_VERT_DIM = 17;
const GRID_QUAD_DIM = GRID_VERT_DIM - 1;
const NUM_VERT_FLOATS = 9;

export default class OpeningFogGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly gfxTextures: GfxTexture[];

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new OpeningFogProgram());

        this.gfxTextures = PASS_TEXTURE_IDS.map((id) => assertExists(biosROM.textures.get(id)).gfxTexture);

        // Vertex format [XYZ], [UV], [RGBA]
        const vertexData = new Float32Array(GRID_VERT_DIM * GRID_VERT_DIM * NUM_VERT_FLOATS);

        // X major in the original
        for (let x = 0; x < GRID_VERT_DIM; ++x) {
            for (let y = 0; y < GRID_VERT_DIM; ++y) {
                const fVar10 = -5.0999994 - ((x * 2 - 16) * 6 * 0.5 + 3);
                let fVar7 = -((y * 2 - 16) * 6 * 0.5 + 3);
                fVar7 = ((72.12489 - Math.sqrt(fVar10 ** 2 + fVar7 ** 2) * 4) * 96) / 72.12489;
                fVar7 = clamp(fVar7, 0, 127) >>> 0;

                const vertOff = (x * 17 + y) * 9;
                vertexData[vertOff] = x * 6 - 48;
                vertexData[vertOff + 1] = y * 6 - 48;
                vertexData[vertOff + 2] = 134;
                vertexData[vertOff + 3] = x * 0.5;
                vertexData[vertOff + 4] = y * 0.5; // Also a scroll for the shader
                vertexData[vertOff + 5] = 0;
                vertexData[vertOff + 6] = 0;
                vertexData[vertOff + 7] = fVar7 / 128;
                vertexData[vertOff + 8] = 128 / 128;
            }
        }

        this.indexCount = GRID_QUAD_DIM * GRID_QUAD_DIM * NUM_FOG_INSTANCES;
        const indexData = new Uint16Array(this.indexCount);

        for (let x = 0; x < GRID_QUAD_DIM; ++x) {
            for (let y = 0; y < GRID_QUAD_DIM; ++y) {
                const indexOff = (x * GRID_QUAD_DIM + y) * 6;
                indexData[indexOff] = x * GRID_VERT_DIM + y;
                indexData[indexOff + 1] = x * GRID_VERT_DIM + (y + 1);
                indexData[indexOff + 2] = (x + 1) * GRID_VERT_DIM + y;
                indexData[indexOff + 3] = (x + 1) * GRID_VERT_DIM + (y + 1);
                indexData[indexOff + 4] = (x + 1) * GRID_VERT_DIM + y;
                indexData[indexOff + 5] = x * GRID_VERT_DIM + (y + 1);
            }
        }

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "OpeningFog (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "OpeningFog (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: OpeningFogProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: OpeningFogProgram.a_TexCoord,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 3 * 4,
                    bufferIndex: 0,
                },
                {
                    location: OpeningFogProgram.a_Color,
                    format: GfxFormat.F32_RGBA,
                    bufferByteOffset: 5 * 4,
                    bufferIndex: 0,
                },
            ],

            vertexBufferDescriptors: [
                {
                    byteStride: NUM_VERT_FLOATS * 4,
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

    public draw(renderInterface: RenderInterface, fogTexScrolls: number[]){
        assert(fogTexScrolls.length === 6);

        const renderInst = renderInterface.renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            {gfxTexture: this.gfxTextures[0], gfxSampler: renderInterface.linearSampler},
            {gfxTexture: this.gfxTextures[1], gfxSampler: renderInterface.linearSampler},
            {gfxTexture: this.gfxTextures[2], gfxSampler: renderInterface.linearSampler}
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{buffer: this.vertexBuffer, byteOffset: 0}],
            {buffer: this.indexBuffer, byteOffset: 0},
        );

        renderInst.setDrawCount(this.indexCount);
        renderInst.setInstanceCount(6);

        const openingFogParams = renderInst.allocateUniformBufferF32(OpeningFogProgram.ub_OpeningFogParams, 8);
        for (let i = 0; i < 6; ++i) {
            openingFogParams[i] = fogTexScrolls[i];
        }

        renderInst.setMegaStateFlags({
            attachmentsState: [
                {
                    channelWriteMask: GfxChannelWriteMask.AllChannels,
                    rgbBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.One,
                        blendDstFactor: GfxBlendFactor.One
                    },
                    alphaBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.One,
                        blendDstFactor: GfxBlendFactor.One
                    }
                }
            ],
            cullMode: GfxCullMode.None
        });

        renderInterface.renderInstList.submitRenderInst(renderInst);
    }
}
