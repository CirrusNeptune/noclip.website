import {GfxBuffer, GfxInputLayout, GfxProgram, type GfxTexture} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBufferFrequencyHint,
    GfxBufferUsage,
    GfxCompareMode,
    GfxCullMode,
    GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import {mat4, vec3} from "gl-matrix";
import {fillMatrix4x3, fillVec4} from "../../gfx/helpers/UniformBufferHelpers";
import IBIOSScene from "../IBIOSScene";
import {BIOSROM} from "../BIOSROM";
import {assert, assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";
import {clamp, setMatrixTranslation} from "../../MathHelpers";

export const NUM_CUBES = 5;

class MultipassCubeProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_TexCoord = 2;

    public static ub_MultipassCubeParams = 1;

    public override vert = `
${MultipassCubeProgram.Common}

layout(location = ${MultipassCubeProgram.a_Position}) in vec3 a_Position;
layout(location = ${MultipassCubeProgram.a_Normal}) in vec3 a_Normal;
layout(location = ${MultipassCubeProgram.a_TexCoord}) in vec2 a_TexCoord;

out vec2 v_ViewNormal2D;
out vec2 v_CubeCenter2D;
out vec2 v_BlprTexCoord;
out vec2 v_BlpTexCoord;
out vec2 v_RefTexCoord;
out float v_CameraNormalDot;

void main() {
    mat4x3 t_CubeWorldFromLocal = UnpackMatrix(u_CubeWorldFromLocal[gl_InstanceID]);
    mat4 t_ViewFromWorld = UnpackMatrix(u_ViewFromWorld);

    vec3 t_PositionWorld = (t_CubeWorldFromLocal * vec4(a_Position.xyz, 1.0f)).xyz;
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_PositionWorld, 1.0f);

    vec3 t_CubeCenterWorld = (t_CubeWorldFromLocal * vec4(0.0, 0.0, 0.0, 1.0f)).xyz;
    vec4 t_CubeCenterClip = UnpackMatrix(u_ClipFromWorld) * vec4(t_CubeCenterWorld, 1.0f);
    v_CubeCenter2D = (t_CubeCenterClip / t_CubeCenterClip.w).xy;

    vec3 t_NormalWorld = mat3(t_CubeWorldFromLocal) * a_Normal.xyz;
    vec3 t_NormalView = normalize(mat3(t_ViewFromWorld) * t_NormalWorld);
    v_ViewNormal2D = t_NormalView.xy;

    vec3 t_PositionView = (t_ViewFromWorld * vec4(t_PositionWorld, 1.0f)).xyz;
    vec3 t_PositionViewNorm = normalize(t_PositionView);
    float t_CameraNormalDot = abs(dot(t_PositionViewNorm, t_NormalView));
    t_CameraNormalDot = 1.0 - t_CameraNormalDot;
    v_CameraNormalDot = t_CameraNormalDot * t_CameraNormalDot * 0.5;

    float BlpScroll = u_Magnification_Refraction_BlpScroll_RefOffset.z;
    v_BlprTexCoord = a_TexCoord - vec2(BlpScroll, -BlpScroll);
    v_BlpTexCoord = a_TexCoord + vec2(BlpScroll, -BlpScroll);

    float RefOffset = u_Magnification_Refraction_BlpScroll_RefOffset.w;
    v_RefTexCoord = ((t_PositionViewNorm + t_NormalView * -RefOffset) + 0.5).xy;
}
`;

    public override frag = `
${MultipassCubeProgram.Common}

in vec2 v_ViewNormal2D;
in vec2 v_CubeCenter2D;
in vec2 v_BlprTexCoord;
in vec2 v_BlpTexCoord;
in vec2 v_RefTexCoord;
in float v_CameraNormalDot;

void main() {
    float Magnification = u_Magnification_Refraction_BlpScroll_RefOffset.x;
    float Refraction = u_Magnification_Refraction_BlpScroll_RefOffset.y;
    float SceneFix = u_SceneFix_RefFix.x;
    float RefFix = u_SceneFix_RefFix.y;

    // Use refraction proportions of a 4:3 aspect ratio.
    ivec2 SceneSize = textureSize(TEXTURE(u_SceneTexture), 0);
    vec2 HalfSceneSize = vec2(SceneSize) * 0.5;
    vec2 HalfSceneSize4x3 = vec2(HalfSceneSize.y * 4.0 / 3.0, HalfSceneSize.y);

    // Scene UV calculations performed in fragment shader to avoid interference from perspective correction.
    // WebGL does not have portable noperspective sadly.
    vec2 CubeCenterScreen = v_CubeCenter2D * HalfSceneSize + HalfSceneSize;
    vec2 RefractOffset = v_ViewNormal2D * HalfSceneSize4x3 * Refraction * gl_FragCoord.w * -4.0;
    vec2 MagnificationOffset = (gl_FragCoord.xy - CubeCenterScreen) * Magnification;
    vec2 ScreenCoord = clamp(gl_FragCoord.xy + RefractOffset + MagnificationOffset, vec2(0.0), vec2(SceneSize - ivec2(1)));
    vec2 SampleCenter = (ScreenCoord + 0.5) / vec2(SceneSize);
    vec3 SceneColor = texture(SAMPLER_2D(u_SceneTexture), SampleCenter).rgb;
    vec3 ModulatedColor = SceneColor * (u_CubeColors.rgb + v_CameraNormalDot * 32.0) * SceneFix / 128.0 / 128.0;

    // TODO: review modulation uniforms
    vec3 Ref = texture(SAMPLER_2D(u_RefTexture), v_RefTexCoord).rgb;
    vec3 ModulatedRef = Ref * u_CubeColors.rgb * (v_CameraNormalDot * 0.4 * 0.6 + 0.2) * RefFix / 64.0 / 128.0;

    float Blpr = texture(SAMPLER_2D(u_BlpcTexture), v_BlprTexCoord).r;
    ModulatedColor += ModulatedRef * Blpr;

    float Blp = texture(SAMPLER_2D(u_BlpcTexture), v_BlpTexCoord).g;
    ModulatedColor += ModulatedRef * Blp;

    gl_FragColor = vec4(ModulatedColor, 1.0);
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_MultipassCubeParams {
    Mat3x4 u_CubeWorldFromLocal[${NUM_CUBES}];
    vec4 u_CubeColors;
    vec4 u_Magnification_Refraction_BlpScroll_RefOffset;
    vec4 u_SceneFix_RefFix;
};

uniform sampler2D u_SceneTexture;
uniform sampler2D u_BlpcTexture;
uniform sampler2D u_RefTexture;
`;

}

const NUM_FACES = 6;
const VERTS_PER_FACE = 4;
const NUM_VERTEX_FLOATS = 8;

export interface CubeParams {
    cubeRotations: vec3[],
    cubeTranslations: vec3[],
    cubeExtent: number,
    colorBias: vec3,
}

export default class MultipassCubeGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly blpcTexture: GfxTexture;
    private readonly refTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new MultipassCubeProgram());

        this.blpcTexture = assertExists(biosROM.textures.get(ResourceID.TEXOBLPC)).gfxTexture;
        this.refTexture = assertExists(biosROM.textures.get(ResourceID.TEXOREF)).gfxTexture;

        // Vertex data for six cube faces
        const vertexData = new Float32Array(NUM_FACES * VERTS_PER_FACE * NUM_VERTEX_FLOATS);
        vertexData.set([
            //   Face 5 - Front 0
            //   X   Y   Z    NX   NY   NZ     U  V
             1, -1, -1,      0,  0, -1,        1, 0, // 1
             1,  1, -1,      0,  0, -1,        1, 1, // 3
            -1, -1, -1,      0,  0, -1,        0, 0, // 0
            -1,  1, -1,      0,  0, -1,        0, 1, // 2

            //   Face 0 - Back 1
            //   X   Y   Z    NX   NY   NZ     U  V
             1, -1,  1,      0,  0,  1,        0, 0, // 0
            -1, -1,  1,      0,  0,  1,        1, 0, // 1
             1,  1,  1,      0,  0,  1,        0, 1, // 2
            -1,  1,  1,      0,  0,  1,        1, 1, // 3

            //   Face 4 - Left 2
            //   X   Y   Z    NX   NY   NZ     U  V
            -1, -1, -1,     -1,  0,  0,        1, 0, // 1
            -1,  1, -1,     -1,  0,  0,        1, 1, // 3
            -1, -1,  1,     -1,  0,  0,        0, 0, // 0
            -1,  1,  1,     -1,  0,  0,        0, 1, // 2

            //   Face 2 - Top 3
            //   X   Y   Z    NX   NY   NZ     U  V
             1,  1,  1,      0,  1,  0,        1, 1, // 3
            -1,  1,  1,      0,  1,  0,        0, 1, // 2
             1,  1, -1,      0,  1,  0,        1, 0, // 1
            -1,  1, -1,      0,  1,  0,        0, 0, // 0

            //   Face 3 - Right 4
            //   X   Y   Z    NX   NY   NZ     U  V
             1, -1,  1,      1,  0,  0,        1, 0, // 1
             1,  1,  1,      1,  0,  0,        1, 1, // 3
             1, -1, -1,      1,  0,  0,        0, 0, // 0
             1,  1, -1,      1,  0,  0,        0, 1, // 2

            //   Face 1 - Bottom 5
            //   X   Y   Z    NX   NY   NZ     U  V
             1, -1, -1,      0, -1,  0,        1, 1, // 3
            -1, -1, -1,      0, -1,  0,        0, 1, // 2
             1, -1,  1,      0, -1,  0,        1, 0, // 1
            -1, -1,  1,      0, -1,  0,        0, 0, // 0
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
        device.setResourceName(this.vertexBuffer, "Multipass Cube (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "Multipass Cube (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: MultipassCubeProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: MultipassCubeProgram.a_Normal,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 3 * 4,
                    bufferIndex: 0,
                },
                {
                    location: MultipassCubeProgram.a_TexCoord,
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

    private drawInternal(biosScene: IBIOSScene, frontface: boolean, magnification: number,
                         refraction: number, blpScroll: number, refOffset: number, sceneFix: number,
                         refFix: number, params: CubeParams) {
        assert(params.cubeRotations.length === NUM_CUBES);
        assert(params.cubeTranslations.length === NUM_CUBES);

        const renderInst = biosScene.renderHelper.renderInstManager.newRenderInst();
        renderInst.setBindingLayouts([
            { numSamplers: 3, numUniformBuffers: 2 },
        ]);

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: null, gfxSampler: null, lateBinding: "sceneColor" },
            { gfxTexture: this.blpcTexture, gfxSampler: biosScene.linearSampler },
            { gfxTexture: this.refTexture, gfxSampler: biosScene.linearSampler },
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);
        renderInst.setInstanceCount(NUM_CUBES);

        const cubeParams = renderInst.allocateUniformBufferF32(
            MultipassCubeProgram.ub_MultipassCubeParams,
            12 * NUM_CUBES + 12);

        let offs = 0;
        for (let i = 0; i < NUM_CUBES; ++i) {
            const cubeMatrix = mat4.create();
            mat4.scale(cubeMatrix, cubeMatrix, [params.cubeExtent, params.cubeExtent, params.cubeExtent]);
            mat4.rotateZ(cubeMatrix, cubeMatrix, params.cubeRotations[i][2]);
            mat4.rotateY(cubeMatrix, cubeMatrix, params.cubeRotations[i][1]);
            mat4.rotateX(cubeMatrix, cubeMatrix, params.cubeRotations[i][0]);
            setMatrixTranslation(cubeMatrix, params.cubeTranslations[i]);
            offs += fillMatrix4x3(cubeParams, offs, cubeMatrix);
        }

        offs += fillVec4(cubeParams, offs,
            clamp(128 + params.colorBias[0], 0, 127),
            clamp(128 + params.colorBias[1], 0, 127),
            clamp(128 + params.colorBias[2], 0, 127));

        offs += fillVec4(cubeParams, offs, magnification, refraction, blpScroll, refOffset);

        offs += fillVec4(cubeParams, offs, sceneFix, refFix);

        renderInst.setMegaStateFlags({
            depthCompare: GfxCompareMode.Always,
            depthWrite: false,
            cullMode: frontface ? GfxCullMode.Back : GfxCullMode.Front,
        });

        const instList = frontface ? biosScene.frontfaceRefractInstList : biosScene.backfaceRefractInstList;
        instList.submitRenderInst(renderInst);
    }

    public draw(biosScene: IBIOSScene, params: CubeParams){
        this.drawInternal(biosScene, false, 0.0, 1.0, 0.00375, -0.25, 122, 42, params);
        this.drawInternal(biosScene, true, -0.084, 1.0, 0.0075, 0.5, 240, 64, params);
    }
}
