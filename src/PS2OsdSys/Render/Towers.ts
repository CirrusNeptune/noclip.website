import {
    GfxBuffer,
    GfxInputLayout,
    GfxProgram,
    type GfxTexture
} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBufferFrequencyHint,
    GfxBufferUsage,
    GfxCullMode, GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import {mat4} from "gl-matrix";
import {fillMatrix4x3} from "../../gfx/helpers/UniformBufferHelpers";
import RenderInterface from "./RenderInterface";
import {BIOSROM} from "../BIOSROM";
import {assert, assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";

export const TOWER_GRID_WIDTH = 14;
export const TOWER_GRID_HEIGHT = 9;
export const NUM_TOWERS = TOWER_GRID_WIDTH * TOWER_GRID_HEIGHT;

class TowersProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_TexCoord = 2;

    public static ub_TowerParams = 1;

    public override vert = `
${TowersProgram.Common}

layout(location = ${TowersProgram.a_Position}) in vec3 a_Position;
layout(location = ${TowersProgram.a_Normal}) in vec3 a_Normal;
layout(location = ${TowersProgram.a_TexCoord}) in vec2 a_TexCoord;

out vec3 v_Color;
out vec2 v_TexCoord;

void main() {
    vec3 t_PositionWorld = (UnpackMatrix(u_TowerWorldFromLocal[gl_InstanceID]) * vec4(a_Position.xyz, 1.0f)).xyz;
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_PositionWorld, 1.0f);

    vec3 vertexColor = vec3(1.0f);
    vec3 lightNormalVector = UnpackMatrix(u_LightVectorMatrix[gl_InstanceID]) * vec4(a_Normal.xyz, 1.0f);
    vec3 lightDot = max(vec3(0.0f), lightNormalVector);
    vec3 lightColor = UnpackMatrix(u_LightColorMatrix) * vec4(lightDot.xyz, 1.0f);
    v_Color = vertexColor * lightColor;

    v_TexCoord = a_TexCoord.xy;
}
`;

    public override frag = `
${TowersProgram.Common}

in vec3 v_Color;
in vec2 v_TexCoord;

void main() {
    gl_FragColor = texture(SAMPLER_2D(u_Texture), v_TexCoord.xy) * vec4(v_Color.xyz, 1.0f);
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_TowerParams {
    Mat3x4 u_TowerWorldFromLocal[${NUM_TOWERS}];
    Mat3x4 u_LightColorMatrix;
    Mat3x4 u_LightVectorMatrix[${NUM_TOWERS}];
};

layout(location = 0) uniform sampler2D u_Texture;
`;

}

const NUM_FACES = 5;
const VERTS_PER_FACE = 4;
const NUM_VERTEX_FLOATS = 8;

const LIGHT_COLOR_MATRIX: mat4 = mat4.fromValues(
    1.0, 1.0, 1.0, 0.0,
    0.8, 0.8, 0.8, 0.0,
    0.8, 0.8, 0.8, 0.0,
    0.4, 0.4, 0.4, 1.0
);

export default class TowersGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly wallTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new TowersProgram());

        this.wallTexture = assertExists(biosROM.textures.get(ResourceID.TEXOWAL0)).gfxTexture;

        // Vertex data for five cube faces
        // Normals are actually anti-normals (i.e. they point "with the light")
        const vertexData = new Float32Array(NUM_FACES * VERTS_PER_FACE * NUM_VERTEX_FLOATS);
        vertexData.set([
            //   Face 0 - Back (skipped because it's degenerate geometry in the original)
            //   X   Y   Z    NX   NY   NZ     U  V

            //   Face 1 - Bottom
            //   X   Y   Z    NX   NY   NZ     U  V
             2, -2, -30,      0,  1, 0,        0.01, 0.01,
             2, -2,  30,      0,  1, 0,        0.24, 0.01,
            -2, -2, -30,      0,  1, 0,        0.01, 0.24,
            -2, -2,  30,      0,  1, 0,        0.24, 0.24,

            //   Face 2 - Top
            //   X   Y   Z    NX   NY   NZ     U  V
             2,  2,  30,      0, -1, 0,        0.01, 0.01,
             2,  2, -30,      0, -1, 0,        0.24, 0.01,
            -2,  2,  30,      0, -1, 0,        0.01, 0.24,
            -2,  2, -30,      0, -1, 0,        0.24, 0.24,

            //   Face 3 - Right
            //   X   Y   Z    NX   NY   NZ     U  V
             2, -2,  30,     -1,  0, 0,        0.01, 0.01,
             2,  2,  30,     -1,  0, 0,        0.24, 0.01,
             2, -2, -30,     -1,  0, 0,        0.01, 0.24,
             2,  2, -30,     -1,  0, 0,        0.24, 0.24,

            //   Face 4 - Left
            //   X   Y   Z    NX   NY   NZ     U  V
            -2, -2, -30,      1,  0, 0,        0.01, 0.01,
            -2,  2, -30,      1,  0, 0,        0.24, 0.01,
            -2, -2,  30,      1,  0, 0,        0.01, 0.24,
            -2,  2,  30,      1,  0, 0,        0.24, 0.24,

            //   Face 5 - Front
            //   X   Y   Z    NX   NY   NZ     U  V
             2, -2, -30,      0,  0, 1,        0.01, 0.01,
            -2, -2, -30,      0,  0, 1,        0.24, 0.01,
             2,  2, -30,      0,  0, 1,        0.01, 0.24,
            -2,  2, -30,      0,  0, 1,        0.24, 0.24,
        ]);

        this.indexCount = NUM_FACES * 6;
        const indexData = new Uint16Array(this.indexCount);

        for (let i = 0; i < NUM_FACES; ++i) {
            const baseIndex = i * 4;
            indexData[i * 6] = baseIndex;
            indexData[i * 6 + 1] = baseIndex + 1;
            indexData[i * 6 + 2] = baseIndex + 2;
            indexData[i * 6 + 3] = baseIndex + 3;
            indexData[i * 6 + 4] = baseIndex + 2;
            indexData[i * 6 + 5] = baseIndex + 1;
        }

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "Towers (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "Towers (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: TowersProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: TowersProgram.a_Normal,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 3 * 4,
                    bufferIndex: 0,
                },
                {
                    location: TowersProgram.a_TexCoord,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 6 * 4,
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

    public draw(renderInterface: RenderInterface, objectMats: mat4[], lightVectorMats: mat4[]){
        assert(objectMats.length === NUM_TOWERS);
        assert(lightVectorMats.length === NUM_TOWERS);

        const renderInst = renderInterface.renderHelper.renderInstManager.newRenderInst();

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: this.wallTexture, gfxSampler: renderInterface.linearSampler }
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);
        renderInst.setInstanceCount(NUM_TOWERS);

        const towerParams = renderInst.allocateUniformBufferF32(TowersProgram.ub_TowerParams, 12 * (NUM_TOWERS * 2 + 1));

        let offs = 0;
        for (let i = 0; i < NUM_TOWERS; ++i) {
            offs += fillMatrix4x3(towerParams, offs, objectMats[i]);
        }

        offs += fillMatrix4x3(towerParams, offs, LIGHT_COLOR_MATRIX);

        for (let i = 0; i < NUM_TOWERS; ++i) {
            offs += fillMatrix4x3(towerParams, offs, lightVectorMats[i]);
        }

        renderInst.setMegaStateFlags({ cullMode: GfxCullMode.None });

        renderInterface.renderInstList.submitRenderInst(renderInst);
    }
}
