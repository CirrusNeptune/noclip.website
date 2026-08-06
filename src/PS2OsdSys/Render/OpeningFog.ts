import {DeviceProgram} from "../../Program";
import {GfxShaderLibrary} from "../../gfx/helpers/GfxShaderLibrary";
import {GfxBuffer, GfxInputLayout, GfxProgram, GfxTexture} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {clamp} from "../../MathHelpers";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBufferFrequencyHint,
    GfxBufferUsage, GfxCullMode,
    GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import RenderInterface from "./RenderInterface";
import {mat4} from "gl-matrix";
import {BaseProgram} from "./Base";
import {assertExists} from "../../util";
import {fillMatrix4x3} from "../../gfx/helpers/UniformBufferHelpers";
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

void main() {
    vec3 t_PositionWorld = (UnpackMatrix(u_WorldFromLocal) * vec4(a_Position.xyz, 1.0f)).xyz;
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_PositionWorld, 1.0f);
    v_TexCoord = a_TexCoord.xy;
    v_Color = a_Color;
}
`;

    public override frag = `
${OpeningFogProgram.Common}

in vec2 v_TexCoord;
in vec4 v_Color;

void main() {
    //gl_FragColor = texture(SAMPLER_2D(u_Texture), v_TexCoord.xy) * v_Color;
    gl_FragColor = vec4(0,0,0,1);
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_OpeningFogParams {
    Mat3x4 u_WorldFromLocal;
};

layout(location = 0) uniform sampler2D u_Texture;
`;

}

const PASS_TEXTURE_IDS = [
    ResourceID.TEXOFOG4,
    ResourceID.TEXOFOG2,
    ResourceID.TEXOFOG1,
    ResourceID.TEXOFOG4,
    ResourceID.TEXOFOG2,
    ResourceID.TEXOFOG1,
];

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
        const vertexData = new Float32Array(17 * 17 * 9);

        // X major in the original
        for (let x = 0; x < 17; ++x) {
            for (let y = 0; y < 17; ++y) {
                const fVar10 = -5.0999994 - ((x * 2 - 16) * 6 * 0.5 + 3);
                let fVar7 = -((y * 2 - 16) * 6 * 0.5 + 3);
                fVar7 = ((72.12489 - Math.sqrt(fVar10 ** 2 + fVar7 ** 2) * 4) * 96) / 72.12489;
                fVar7 = clamp(fVar7, 0, 127) >>> 0;

                const vertOff = (x * 17 + y) * 9;
                vertexData[vertOff] = x * 6 - 48;
                vertexData[vertOff + 1] = x * 6 - 48;
                vertexData[vertOff + 2] = 134;
                vertexData[vertOff + 3] = x * 0.5;
                vertexData[vertOff + 4] = y * 0.5; // Also a scroll for the shader
                vertexData[vertOff + 5] = 0;
                vertexData[vertOff + 6] = 0;
                vertexData[vertOff + 7] = fVar7 / 255;
                vertexData[vertOff + 8] = 128 / 255;
            }
        }

        this.indexCount = 16 * 16 * 6;
        const indexData = new Uint16Array(this.indexCount);

        for (let x = 0; x < 16; ++x) {
            for (let y = 0; y < 16; ++y) {
                const indexOff = (x * 16 + y) * 6;
                indexData[indexOff] = x * 17 + y;
                indexData[indexOff + 1] = x * 17 + (y + 1);
                indexData[indexOff + 2] = (x + 1) * 17 + y;
                indexData[indexOff + 3] = (x + 1) * 17 + (y + 1);
                indexData[indexOff + 4] = (x + 1) * 17 + y;
                indexData[indexOff + 5] = x * 17 + (y + 1);
            }
        }

        let temp = [
            [0, 0],
            [0, -1],
            [1, 0]
        ];
        for (let i = 0; i < 3; ++i) {
            const vertOff = i * 9;
            vertexData[vertOff] = temp[i][0];
            vertexData[vertOff + 1] = temp[i][1];
            vertexData[vertOff + 2] = 0;
            vertexData[vertOff + 3] = 0;
            vertexData[vertOff + 4] = 0;
            vertexData[vertOff + 5] = 0;
            vertexData[vertOff + 6] = 0;
            vertexData[vertOff + 7] = 0;
            vertexData[vertOff + 8] = 0;
        }

        indexData[0] = 0;
        indexData[1] = 1;
        indexData[2] = 2;

        this.indexCount = 3;

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
                    byteStride: 9 * 4,
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

    public draw(renderInterface: RenderInterface, lightVectorMat: mat4){
        for (let p = 0; p < 6; ++p) {
            const renderInst = renderInterface.renderHelper.renderInstManager.newRenderInst();

            renderInst.setGfxProgram(this.gfxProgram);

            renderInst.setSamplerBindings(0, [
                {gfxTexture: this.gfxTextures[p], gfxSampler: renderInterface.linearSampler}
            ]);

            renderInst.setVertexInput(
                this.inputLayout,
                [{buffer: this.vertexBuffer, byteOffset: 0}],
                {buffer: this.indexBuffer, byteOffset: 0},
            );

            renderInst.setDrawCount(this.indexCount);

            // Create a transform for our cube.
            const fogMatrix = mat4.create();
            // Move it back a bit.
            mat4.translate(fogMatrix, fogMatrix, [0, 0, 0 - p * 5]);
            // Rotate it over time.
            //mat4.rotateX(fogMatrix, fogMatrix, time * 0.0007);
            //mat4.rotateY(fogMatrix, fogMatrix, time * 0.0003);
            // Scale up our cube by 50 to make it larger on the screen.
            mat4.scale(fogMatrix, fogMatrix, [50, 50, 50]);

            // Now upload our cube's parameter data to the GPU, which is our matrix.
            // This is a Mat3x4, which is 3 groups of 4 floats.
            const openingFogParams = renderInst.allocateUniformBufferF32(OpeningFogProgram.ub_OpeningFogParams, 12);
            let offs = 0;
            offs += fillMatrix4x3(openingFogParams, offs, fogMatrix);

            // Turn on backface culling. This is one of the fixed-function settings available through the MegaStateFlags.
            renderInst.setMegaStateFlags({cullMode: GfxCullMode.None});

            // Now that we're done setting up our render object, we can add it to our list of objects...
            renderInterface.renderInstList.submitRenderInst(renderInst);
        }
    }
}
