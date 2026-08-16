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
import {mat4, vec3, vec4} from "gl-matrix";
import {fillMatrix4x3, fillVec3v, fillVec4v} from "../../gfx/helpers/UniformBufferHelpers";
import RenderInterface from "./RenderInterface";
import {BIOSROM} from "../BIOSROM";
import {assert, assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";

export const NUM_FLARES = 4;
export const NUM_FLARE_OVERDRAWS = 4;

class OpeningFlaresProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_TexCoord = 1;

    public static ub_FlaresParams = 1;

    public override vert = `
${OpeningFlaresProgram.Common}

layout(location = ${OpeningFlaresProgram.a_Position}) in vec3 a_Position;
layout(location = ${OpeningFlaresProgram.a_TexCoord}) in vec2 a_TexCoord;

out vec4 v_Color;
out vec2 v_TexCoord;

void main() {
    vec3 t_PositionWorld = u_FlarePos[gl_InstanceID].xyz + a_Position.xyz;
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_PositionWorld, 1.0f);
    if (gl_VertexID < 4) {
        // Color part
        v_Color.rgb = u_FlareColor[gl_InstanceID / ${NUM_FLARE_OVERDRAWS}].rgb * 0.5f;
        v_Color.a = float((gl_InstanceID % ${NUM_FLARE_OVERDRAWS}) + 1) * (24.f / 2.5f / 128.f);
    } else {
        // Highlight part
        v_Color.rgb = vec3(1.f);
        v_Color.a = float((gl_InstanceID % ${NUM_FLARE_OVERDRAWS}) + 1) * (12.f / 2.5f / 128.f);
    }
    v_TexCoord = a_TexCoord.xy;
}
`;

    public override frag = `
${OpeningFlaresProgram.Common}

in vec4 v_Color;
in vec2 v_TexCoord;

void main() {
    gl_FragColor.rgb = v_Color.rgb;
    gl_FragColor.a = texture(SAMPLER_2D(u_Texture), v_TexCoord.xy).a * v_Color.a;
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_FlaresParams {
    vec4 u_FlarePos[${NUM_FLARES * NUM_FLARE_OVERDRAWS}];
    vec4 u_FlareColor[${NUM_FLARES}];
};

uniform sampler2D u_Texture;
`;

}

const NUM_VERTEX_FLOATS = 5;

export default class OpeningFlaresGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly flareTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new OpeningFlaresProgram());

        this.flareTexture = assertExists(biosROM.textures.get(ResourceID.TEXOCRBL)).gfxTexture;

        // Vertex data for flares, large outer color and small inner highlight
        const vertexData = new Float32Array(4 * 2 * NUM_VERTEX_FLOATS);
        vertexData.set([
            //   Quad 0 - Color
            //   X   Y   Z      U  V
            -0.8, -0.8, 0,      0.0, 0.0,
             0.8, -0.8, 0,      1.0, 0.0,
            -0.8,  0.8, 0,      0.0, 1.0,
             0.8,  0.8, 0,      1.0, 1.0,

            //   Quad 1 - Highlight
            //   X   Y   Z      U  V
            -0.25, -0.25, 0,    0.0, 0.0,
             0.25, -0.25, 0,    1.0, 0.0,
            -0.25,  0.25, 0,    0.0, 1.0,
             0.25,  0.25, 0,    1.0, 1.0,
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
        device.setResourceName(this.vertexBuffer, "Flares (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "Flares (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: OpeningFlaresProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: OpeningFlaresProgram.a_TexCoord,
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

    public draw(renderInterface: RenderInterface, flarePos: vec3[], flareColors: vec4[]){
        assert(flarePos.length === NUM_FLARES * NUM_FLARE_OVERDRAWS);
        assert(flareColors.length === NUM_FLARES);

        const renderInst = renderInterface.renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: this.flareTexture, gfxSampler: renderInterface.linearSampler }
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);
        renderInst.setInstanceCount(NUM_FLARES * NUM_FLARE_OVERDRAWS);

        const flareParams = renderInst.allocateUniformBufferF32(
            OpeningFlaresProgram.ub_FlaresParams, 12 * NUM_FLARES * NUM_FLARE_OVERDRAWS + 4 * NUM_FLARES);

        let offs = 0;
        for (let i = 0; i < NUM_FLARES * NUM_FLARE_OVERDRAWS; ++i) {
            offs += fillVec3v(flareParams, offs, flarePos[i]);
        }

        for (let i = 0; i < NUM_FLARES; ++i) {
            offs += fillVec4v(flareParams, offs, flareColors[i]);
        }

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

        renderInterface.mainInstList.submitRenderInst(renderInst);
    }
}
