import {GfxBuffer, GfxInputLayout, GfxProgram, type GfxTexture} from "../../gfx/platform/GfxPlatformImpl";
import {GfxRenderCache} from "../../gfx/render/GfxRenderCache";
import {createBufferFromData} from "../../gfx/helpers/BufferHelpers";
import {
    GfxBlendFactor,
    GfxBlendMode,
    GfxBufferFrequencyHint,
    GfxBufferUsage,
    GfxChannelWriteMask,
    GfxCompareMode,
    GfxCullMode,
    GfxDevice,
    GfxVertexBufferFrequency
} from "../../gfx/platform/GfxPlatform";
import {GfxFormat} from "../../gfx/platform/GfxPlatformFormat";
import {mat4, vec3} from "gl-matrix";
import {fillMatrix4x3, fillVec3v, fillVec4} from "../../gfx/helpers/UniformBufferHelpers";
import IBIOSScene from "../IBIOSScene";
import {BIOSROM} from "../BIOSROM";
import {assertExists} from "../../util";
import {ResourceID} from "../ResourceIDs";
import {BaseProgram} from "./Base";
import {GfxRenderInstList} from "../../gfx/render/GfxRenderInstManager";

class ClockCrystalProgram extends BaseProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_TexCoord = 2;
    public static a_QuadIdx = 3;

    public static ub_ClockCrystalParams = 1;

    public override vert = `
${ClockCrystalProgram.Common}

layout(location = ${ClockCrystalProgram.a_Position}) in vec3 a_Position;
layout(location = ${ClockCrystalProgram.a_Normal}) in vec3 a_Normal;
layout(location = ${ClockCrystalProgram.a_TexCoord}) in vec2 a_TexCoord;
layout(location = ${ClockCrystalProgram.a_QuadIdx}) in float a_QuadIdx;

out vec3 v_AddColor;
out vec2 v_TexCoordSub;
out vec2 v_TexCoordAdd;
out vec2 v_ViewNormal2D;
out vec2 v_Center2D;
out float v_CameraNormalDotHighlight;

#define PI ${Math.PI}

void main() {
    mat4x3 t_WorldFromLocal = UnpackMatrix(u_WorldFromLocal);
    mat4 t_ViewFromWorld = UnpackMatrix(u_ViewFromWorld);

    vec3 t_PositionWorld = (t_WorldFromLocal * vec4(a_Position.xyz, 1.0f)).xyz;
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_PositionWorld, 1.0f);

    vec3 t_NormalWorld = mat3(t_WorldFromLocal) * a_Normal.xyz;
    vec3 t_NormalView = normalize(mat3(t_ViewFromWorld) * t_NormalWorld);
    v_ViewNormal2D = t_NormalView.xy;

    vec3 t_CenterWorld = (t_WorldFromLocal * vec4(0.0, 0.0, 0.0, 1.0f)).xyz;
    vec4 t_CenterClip = UnpackMatrix(u_ClipFromWorld) * vec4(t_CenterWorld, 1.0f);
    v_Center2D = (t_CenterClip / t_CenterClip.w).xy * 0.9;

    vec3 t_CenterView = (t_ViewFromWorld * vec4(t_CenterWorld, 1.0f)).xyz;
    vec3 t_CenterViewNorm = normalize(t_CenterView);
    float t_CameraNormalDot = abs(dot(t_CenterViewNorm, t_NormalView));
    t_CameraNormalDot = 1.0 - t_CameraNormalDot;
    float t_ViewDotScale = u_AddColor_ViewDotScale.a;
    v_CameraNormalDotHighlight = t_ViewDotScale * 10.0 * t_CameraNormalDot * t_CameraNormalDot * t_CameraNormalDot * t_CameraNormalDot;
    if (t_CameraNormalDot > 0.9)
        v_CameraNormalDotHighlight *= (1.0 - cos((1.0 - t_CameraNormalDot) * PI * 10.0)) * 0.5;
    v_CameraNormalDotHighlight /= 128.0;

    v_AddColor = u_AddColor_ViewDotScale.rgb;

    float TexScrollStep = u_Magnification_Refraction_TexScrollStep.z;
    v_TexCoordSub = a_TexCoord + vec2((TexScrollStep + a_QuadIdx) / 10.0);
    v_TexCoordAdd = v_TexCoordSub + u_TexAddScrollXY.xy;
}
`;

    public override frag = `
${ClockCrystalProgram.Common}

in vec3 v_AddColor;
in vec2 v_TexCoordSub;
in vec2 v_TexCoordAdd;
in vec2 v_ViewNormal2D;
in vec2 v_Center2D;
in float v_CameraNormalDotHighlight;

void main() {
    float Magnification = u_Magnification_Refraction_TexScrollStep.x;
    float Refraction = u_Magnification_Refraction_TexScrollStep.y;

    // Use refraction proportions of a 4:3 aspect ratio.
    ivec2 SceneSize = textureSize(TEXTURE(u_SceneTexture), 0);
    vec2 HalfSceneSize = vec2(SceneSize) * 0.5;
    vec2 HalfSceneSize4x3 = vec2(HalfSceneSize.y * 4.0 / 3.0, HalfSceneSize.y);

    // Scene UV calculations performed in fragment shader to avoid interference from perspective correction.
    // WebGL does not have portable noperspective sadly.
    vec2 CenterScreen = v_Center2D * HalfSceneSize + HalfSceneSize;
    vec2 MagnificationOffset = (gl_FragCoord.xy - CenterScreen) * Magnification + CenterScreen;
    vec2 RefractOffset = v_ViewNormal2D * HalfSceneSize4x3 * Refraction * gl_FragCoord.w;
    vec2 ScreenCoord = clamp(MagnificationOffset - RefractOffset, vec2(0.0), vec2(SceneSize - ivec2(1)));
    vec2 SampleCenter = (ScreenCoord + 0.5) / vec2(SceneSize);
    vec3 SceneColor = texture(SAMPLER_2D(u_SceneTexture), SampleCenter).rgb;

    float BumpSampleSub = texture(SAMPLER_2D(u_Texture), v_TexCoordSub).r;
    float BumpSampleAdd = texture(SAMPLER_2D(u_Texture), v_TexCoordAdd).r;
    vec3 ModulatedColor = SceneColor + vec3(BumpSampleAdd - BumpSampleSub) * u_BumpRGB.rgb;

    gl_FragColor.rgb = vec3(v_CameraNormalDotHighlight) + ModulatedColor;
    //gl_FragColor.rgb = texture(SAMPLER_2D(u_Texture), v_TexCoordSub).rgb;
    gl_FragColor.a = 1.f;

    vec2 Blah = (gl_FragCoord.xy - CenterScreen) / 1000.0;
    //gl_FragColor.rgb = vec3(Blah.x, Blah.y, 0.0);
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_ClockCrystalParams {
    Mat3x4 u_WorldFromLocal;
    vec4 u_AddColor_ViewDotScale;
    vec4 u_Magnification_Refraction_TexScrollStep;
    vec4 u_TexAddScrollXY;
    vec4 u_BumpRGB;
};

uniform sampler2D u_SceneTexture;
uniform sampler2D u_Texture;
`;

}

const NUM_QUADS = 16;
const NUM_VERTEX_FLOATS = 9;

const CLOCK_CRYSTAL_VERT_TRANSLATIONS: number[] = [
    -117 / 100, 2639 / 100, -202644 / 100000,
    117 / 100, 2639 / 100, 202644 / 100000,
    -234 / 100, 2639 / 100, 0 / 100000,
    -117 / 100, 2639 / 100, 202644 / 100000,

    117 / 100, 2639 / 100, 202644 / 100000,
    -117 / 100, 2639 / 100, -202644 / 100000,
    234 / 100, 2639 / 100, 0 / 100000,
    117 / 100, 2639 / 100, -202644 / 100000,

    117 / 100, 2639 / 100, 202644 / 100000,
    130 / 100, 2600 / 100, 225160 / 100000,
    -117 / 100, 2639 / 100, 202644 / 100000,
    -130 / 100, 2600 / 100, 225160 / 100000,

    130 / 100, 2600 / 100, -225160 / 100000,
    117 / 100, 2639 / 100, -202644 / 100000,
    -130 / 100, 2600 / 100, -225160 / 100000,
    -117 / 100, 2639 / 100, -202644 / 100000,

    117 / 100, 2639 / 100, 202644 / 100000,
    234 / 100, 2639 / 100, 0 / 100000,
    130 / 100, 2600 / 100, 225160 / 100000,
    260 / 100, 2600 / 100, 0 / 100000,

    234 / 100, 2639 / 100, 0 / 100000,
    117 / 100, 2639 / 100, -202644 / 100000,
    260 / 100, 2600 / 100, 0 / 100000,
    130 / 100, 2600 / 100, -225160 / 100000,

    -234 / 100, 2639 / 100, 0 / 100000,
    -117 / 100, 2639 / 100, 202644 / 100000,
    -260 / 100, 2600 / 100, 0 / 100000,
    -130 / 100, 2600 / 100, 225160 / 100000,

    -117 / 100, 2639 / 100, -202644 / 100000,
    -234 / 100, 2639 / 100, 0 / 100000,
    -130 / 100, 2600 / 100, -225160 / 100000,
    -260 / 100, 2600 / 100, 0 / 100000,

    130 / 100, 0 / 100, 225160 / 100000,
    -130 / 100, 0 / 100, -225160 / 100000,
    -130 / 100, 0 / 100, 225160 / 100000,
    -260 / 100, 0 / 100, 0 / 100000,

    -130 / 100, 0 / 100, -225160 / 100000,
    130 / 100, 0 / 100, 225160 / 100000,
    130 / 100, 0 / 100, -225160 / 100000,
    260 / 100, 0 / 100, 0 / 100000,

    130 / 100, 2600 / 100, 225160 / 100000,
    130 / 100, 0 / 100, 225160 / 100000,
    -130 / 100, 2600 / 100, 225160 / 100000,
    -130 / 100, 0 / 100, 225160 / 100000,

    130 / 100, 0 / 100, -225160 / 100000,
    130 / 100, 2600 / 100, -225160 / 100000,
    -130 / 100, 0 / 100, -225160 / 100000,
    -130 / 100, 2600 / 100, -225160 / 100000,

    130 / 100, 2600 / 100, 225160 / 100000,
    260 / 100, 2600 / 100, 0 / 100000,
    130 / 100, 0 / 100, 225160 / 100000,
    260 / 100, 0 / 100, 0 / 100000,

    260 / 100, 2600 / 100, 0 / 100000,
    130 / 100, 2600 / 100, -225160 / 100000,
    260 / 100, 0 / 100, 0 / 100000,
    130 / 100, 0 / 100, -225160 / 100000,

    -260 / 100, 2600 / 100, 0 / 100000,
    -130 / 100, 2600 / 100, 225160 / 100000,
    -260 / 100, 0 / 100, 0 / 100000,
    -130 / 100, 0 / 100, 225160 / 100000,

    -130 / 100, 2600 / 100, -225160 / 100000,
    -260 / 100, 2600 / 100, 0 / 100000,
    -130 / 100, 0 / 100, -225160 / 100000,
    -260 / 100, 0 / 100, 0 / 100000,
];

const CLOCK_CRYSTAL_VERT_STS: number[] = [
    -2 / 10, -3464 / 10000,
    2 / 10, 3464 / 10000,
    -4 / 10, 0 / 10000,
    -2 / 10, 3464 / 10000,

    2 / 10, 3464 / 10000,
    -2 / 10, -3464 / 10000,
    4 / 10, 0 / 10000,
    2 / 10, -3464 / 10000,

    2 / 10, 20 / 10000,
    2 / 10, 0 / 10000,
    0 / 10, 20 / 10000,
    0 / 10, 0 / 10000,

    2 / 10, 0 / 10000,
    2 / 10, 20 / 10000,
    0 / 10, 0 / 10000,
    0 / 10, 20 / 10000,

    0 / 10, 20 / 10000,
    2 / 10, 20 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,

    2 / 10, 20 / 10000,
    0 / 10, 20 / 10000,
    2 / 10, 0 / 10000,
    0 / 10, 0 / 10000,

    0 / 10, 20 / 10000,
    2 / 10, 20 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,

    2 / 10, 20 / 10000,
    0 / 10, 20 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,

    -2 / 10, -3464 / 10000,
    2 / 10, 3464 / 10000,
    -4 / 10, 0 / 10000,
    -2 / 10, 3464 / 10000,

    2 / 10, 3464 / 10000,
    -2 / 10, -3464 / 10000,
    4 / 10, 0 / 10000,
    2 / 10, -3464 / 10000,

    2 / 10, 26000 / 10000,
    2 / 10, 0 / 10000,
    0 / 10, 26000 / 10000,
    0 / 10, 0 / 10000,

    2 / 10, 0 / 10000,
    2 / 10, 26000 / 10000,
    0 / 10, 0 / 10000,
    0 / 10, 26000 / 10000,

    0 / 10, 26000 / 10000,
    2 / 10, 26000 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,

    2 / 10, 26000 / 10000,
    0 / 10, 26000 / 10000,
    2 / 10, 0 / 10000,
    0 / 10, 0 / 10000,

    0 / 10, 26000 / 10000,
    2 / 10, 26000 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,

    2 / 10, 26000 / 10000,
    0 / 10, 26000 / 10000,
    0 / 10, 0 / 10000,
    2 / 10, 0 / 10000,
];

const CLOCK_CRYSTAL_QUAD_NORMS: number[] = [
    0 / 1000000, 10000 / 10000, 0 / 10000,
    0 / 1000000, 10000 / 10000, 0 / 10000,
    0 / 1000000, 7070 / 10000, 7070 / 10000,
    0 / 1000000, 7070 / 10000, -7070 / 10000,
    612262 / 1000000, 0 / 10000, 3535 / 10000,
    612262 / 1000000, 0 / 10000, -3535 / 10000,
    -612262 / 1000000, 0 / 10000, 3535 / 10000,
    -612262 / 1000000, 0 / 10000, -3535 / 10000,
    0 / 1000000, -10000 / 10000, 0 / 10000,
    0 / 1000000, -10000 / 10000, 0 / 10000,
    0 / 1000000, 0 / 10000, 10000 / 10000,
    0 / 1000000, 0 / 10000, -10000 / 10000,
    866000 / 1000000, 0 / 10000, 5000 / 10000,
    866000 / 1000000, 0 / 10000, -5000 / 10000,
    -866000 / 1000000, 0 / 10000, 5000 / 10000,
    -866000 / 1000000, 0 / 10000, -5000 / 10000,
];

export default class ClockCrystalGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;
    private readonly crysTexture: GfxTexture;

    constructor(cache: GfxRenderCache, biosROM: BIOSROM) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new ClockCrystalProgram());

        this.crysTexture = assertExists(biosROM.textures.get(ResourceID.TEXCCRYS)).gfxTexture;

        // Format: (XYZ, NXNYNZ, ST, QIDX)
        const vertexData = new Float32Array(NUM_QUADS * 4 * NUM_VERTEX_FLOATS);

        for (let quad = 0; quad < NUM_QUADS; ++quad) {
            const quadBaseVert = quad * 4 * NUM_VERTEX_FLOATS;
            const quadBaseVertIn = quad * 4 * 3;
            const quadBaseNormIn = quad * 3;
            const quadBaseStIn = quad * 4 * 2;
            for (let quadVert = 0; quadVert < 4; ++quadVert) {
                const baseVert = quadBaseVert + quadVert * NUM_VERTEX_FLOATS;
                const baseVertIn = quadBaseVertIn + quadVert * 3;
                const baseStIn = quadBaseStIn + quadVert * 2;
                vertexData[baseVert] = CLOCK_CRYSTAL_VERT_TRANSLATIONS[baseVertIn];
                vertexData[baseVert + 1] = CLOCK_CRYSTAL_VERT_TRANSLATIONS[baseVertIn + 1];
                vertexData[baseVert + 2] = CLOCK_CRYSTAL_VERT_TRANSLATIONS[baseVertIn + 2];
                vertexData[baseVert + 3] = CLOCK_CRYSTAL_QUAD_NORMS[quadBaseNormIn];
                vertexData[baseVert + 4] = CLOCK_CRYSTAL_QUAD_NORMS[quadBaseNormIn + 1];
                vertexData[baseVert + 5] = CLOCK_CRYSTAL_QUAD_NORMS[quadBaseNormIn + 2];
                vertexData[baseVert + 6] = CLOCK_CRYSTAL_VERT_STS[baseStIn];
                vertexData[baseVert + 7] = CLOCK_CRYSTAL_VERT_STS[baseStIn + 1];
                vertexData[baseVert + 8] = quad;
            }
        }

        this.indexCount = NUM_QUADS * 6;
        const indexData = new Uint16Array(this.indexCount);

        for (let i = 0; i < NUM_QUADS; ++i) {
            const baseIndex = i * 4;
            indexData[i * 6] = baseIndex;
            indexData[i * 6 + 1] = baseIndex + 1;
            indexData[i * 6 + 2] = baseIndex + 2;
            indexData[i * 6 + 3] = baseIndex + 3;
            indexData[i * 6 + 4] = baseIndex + 2;
            indexData[i * 6 + 5] = baseIndex + 1;
        }

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "ClockCrystal (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "ClockCrystal (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: ClockCrystalProgram.a_Position,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 0,
                    bufferIndex: 0,
                },
                {
                    location: ClockCrystalProgram.a_Normal,
                    format: GfxFormat.F32_RGB,
                    bufferByteOffset: 3 * 4,
                    bufferIndex: 0,
                },
                {
                    location: ClockCrystalProgram.a_TexCoord,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 6 * 4,
                    bufferIndex: 0,
                },
                {
                    location: ClockCrystalProgram.a_QuadIdx,
                    format: GfxFormat.F32_R,
                    bufferByteOffset: 8 * 4,
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
                frontface: boolean,
                objMatrix: mat4,
                bumpRGB: vec3){
        const renderInst = biosScene.renderHelper.renderInstManager.newRenderInst();
        renderInst.setBindingLayouts([
            { numSamplers: 2, numUniformBuffers: 2 },
        ]);

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setSamplerBindings(0, [
            { gfxTexture: null, gfxSampler: null, lateBinding: "sceneColor" },
            { gfxTexture: this.crysTexture, gfxSampler: biosScene.linearSampler }
        ]);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);

        const clockCrystalParams = renderInst.allocateUniformBufferF32(
            ClockCrystalProgram.ub_ClockCrystalParams, 12 + 4 + 4 + 4 + 4);

        let offs = 0;
        offs += fillMatrix4x3(clockCrystalParams, offs, objMatrix);

        offs += fillVec4(clockCrystalParams, offs, 0.25, 0.25, 0.25, 10.0);

        const magnification = 0.95;
        const refraction = 1;
        offs += fillVec4(clockCrystalParams, offs, magnification, refraction, 0, 0);

        const texScrollAddX = 0.5;
        const texScrollAddY = 0.5;
        offs += fillVec4(clockCrystalParams, offs, texScrollAddX, texScrollAddY, 0, 0);

        offs += fillVec3v(clockCrystalParams, offs, bumpRGB);

        renderInst.setMegaStateFlags({
            attachmentsState: [
                {
                    channelWriteMask: GfxChannelWriteMask.AllChannels,
                    rgbBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.SrcAlpha,
                        blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha
                    },
                    alphaBlendState: {
                        blendMode: GfxBlendMode.Add,
                        blendSrcFactor: GfxBlendFactor.SrcAlpha,
                        blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha
                    }
                }
            ],
            cullMode: frontface ? GfxCullMode.Back : GfxCullMode.Front,
            depthCompare: GfxCompareMode.GreaterEqual,
            depthWrite: true,
        });

        instList.submitRenderInst(renderInst);
    }
}
