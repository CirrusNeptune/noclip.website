import {
    GfxBuffer,
    GfxInputLayout,
    GfxProgram,
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
import {fillVec3v, fillVec4v} from "../../gfx/helpers/UniformBufferHelpers";
import RenderInterface from "./RenderInterface";
import {assert} from "../../util";
import {BaseProgram} from "./Base";

// This takes us right up to the 16K uniform block size limit imposed by Apple devices
// and is coincidentally exactly what the flair trails need.
// Positions and colors are in separate uniform blocks as a result.
export const MAX_LINE_SEGMENTS = 512;

class LinesProgram extends BaseProgram {
    public static a_Position = 0;

    public static ub_LinePos = 1;
    public static ub_LineColor = 2;

    public override vert = `
${LinesProgram.Common}

layout(location = ${LinesProgram.a_Position}) in vec2 a_Position;

out vec4 v_Color;

#define LINE_THICKNESS 0.002f

void main() {
    // Super basic screen-space line-segment-as-quad setup.
    // Does not perform mitering or ensure manifold geometry between segments in any way.
    // Still, provides decent resolution-independent lines for OSDSYS flares
    // without relying on line primitives.
    mat4 ClipFromWorld = UnpackMatrix(u_ClipFromWorld);
    vec4 Pos0 = vec4(u_LinePos[gl_InstanceID * 2].xyz, 1.0f);
    vec4 Pos1 = vec4(u_LinePos[gl_InstanceID * 2 + 1].xyz, 1.0f);
    float CameraAspectCorrect = u_LinePos[0].w;

    vec4 Pos0ClipNDC = ClipFromWorld * Pos0;
    Pos0ClipNDC /= Pos0ClipNDC.w;
    vec4 Pos1ClipNDC = ClipFromWorld * Pos1;
    Pos1ClipNDC /= Pos1ClipNDC.w;

    vec2 DeltaDir = normalize(Pos1ClipNDC.xy - Pos0ClipNDC.xy);
    vec2 DeltaPerp = vec2(DeltaDir.y, -DeltaDir.x);
    DeltaPerp.x *= CameraAspectCorrect;

    vec4 Pos = mix(Pos0, Pos1, a_Position.y);
    gl_Position = ClipFromWorld * vec4(Pos.xyz, 1.0f);
    gl_Position.xy += DeltaPerp * a_Position.x * LINE_THICKNESS * gl_Position.w;

    vec4 Color0 = u_LineColor[gl_InstanceID * 2];
    vec4 Color1 = u_LineColor[gl_InstanceID * 2 + 1];
    v_Color = mix(Color0, Color1, a_Position.y);
}
`;

    public override frag = `
${LinesProgram.Common}

in vec4 v_Color;

void main() {
    gl_FragColor = v_Color;
}
`;

    public static Common = `
${BaseProgram.BaseCommon}

layout(std140) uniform ub_LinePos {
    vec4 u_LinePos[${MAX_LINE_SEGMENTS * 2}];
};
layout(std140) uniform ub_LineColor {
    vec4 u_LineColor[${MAX_LINE_SEGMENTS * 2}];
};
`;

}

const NUM_VERTEX_FLOATS = 2;

export default class LinesGeometry {
    private readonly vertexBuffer: GfxBuffer;
    private readonly indexBuffer: GfxBuffer;
    private readonly indexCount: number;
    private readonly inputLayout: GfxInputLayout;
    private readonly gfxProgram: GfxProgram;

    constructor(cache: GfxRenderCache) {
        const device = cache.device;

        this.gfxProgram = cache.createProgram(new LinesProgram());

        // Vertex data for flares, large outer color and small inner highlight
        const vertexData = new Float32Array(4 * NUM_VERTEX_FLOATS);
        vertexData.set([
            //   Line Quad
            //   X   Y
            -1, 0,
             1, 0,
            -1, 1,
             1, 1,
        ]);

        this.indexCount = 6;
        const indexData = new Uint16Array(this.indexCount);
        indexData.set([
            0, 1, 2, 3, 2, 1
        ]);

        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, vertexData.buffer);
        device.setResourceName(this.vertexBuffer, "Lines (VB)");

        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indexData.buffer);
        device.setResourceName(this.indexBuffer, "Lines (IB)");

        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                {
                    location: LinesProgram.a_Position,
                    format: GfxFormat.F32_RG,
                    bufferByteOffset: 0,
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

    public draw(renderInterface: RenderInterface, lines: vec3[], lineColors: vec4[], cameraAspect: number){
        assert(lines.length <= MAX_LINE_SEGMENTS * 2);

        const renderInst = renderInterface.renderHelper.renderInstManager.newRenderInst();
        renderInst.setBindingLayouts([
            { numSamplers: 0, numUniformBuffers: 3 },
        ]);

        renderInst.setGfxProgram(this.gfxProgram);

        renderInst.setVertexInput(
            this.inputLayout,
            [{ buffer: this.vertexBuffer, byteOffset: 0 }],
            { buffer: this.indexBuffer, byteOffset: 0 },
        );

        renderInst.setDrawCount(this.indexCount);
        renderInst.setInstanceCount(lines.length >>> 1);

        const linePosBuf = renderInst.allocateUniformBufferF32(
            LinesProgram.ub_LinePos, 4 * MAX_LINE_SEGMENTS * 2);

        let offs = 0;
        for (let i = 0; i < lines.length; ++i) {
            offs += fillVec3v(linePosBuf, offs, lines[i]);
        }

        linePosBuf[3] = 1.0 / cameraAspect;

        const lineColorBuf = renderInst.allocateUniformBufferF32(
            LinesProgram.ub_LineColor, 4 * MAX_LINE_SEGMENTS * 2);

        offs = 0;
        for (let i = 0; i < lines.length; ++i) {
            offs += fillVec4v(lineColorBuf, offs, lineColors[i]);
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

        renderInterface.renderInstList.submitRenderInst(renderInst);
    }
}
