import {mat4, vec3} from "gl-matrix";
import {lerpAngle, MathConstants} from "../MathHelpers";

const scratchVec: vec3 = vec3.create();

export function zeroMatrix(out: mat4) {
    for (let i = 0; i < 16; ++i) {
        out[i] = 0.0;
    }
}

export function normalizeAngle(x: number): number {
    x = x % MathConstants.TAU;
    if (x > Math.PI)
        x -= MathConstants.TAU;
    else if (x < -Math.PI)
        x += MathConstants.TAU;
    return x;
}

export function normalizeAngleVec3(outVec: vec3, inVec: vec3): vec3 {
    for (let c = 0; c < 3; ++c)
        outVec[c] = normalizeAngle(inVec[c]);
    return outVec;
}

export function lerpAngleVec3(outVec: vec3, a: vec3, b: vec3, t: number): vec3 {
    for (let c = 0; c < 3; ++c)
        outVec[c] = lerpAngle(a[c], b[c], t);
    return outVec;
}

export function normalLightMatrix(out: mat4, l0: vec3, l1: vec3, l2: vec3): mat4 {
    vec3.normalize(scratchVec, l0);
    out[0] = -scratchVec[0];
    out[4] = -scratchVec[1];
    out[8] = -scratchVec[2];
    out[12] = 0.0;
    vec3.normalize(scratchVec, l1);
    out[1] = -scratchVec[0];
    out[5] = -scratchVec[1];
    out[9] = -scratchVec[2];
    out[13] = 0.0;
    vec3.normalize(scratchVec, l2);
    out[2] = -scratchVec[0];
    out[6] = -scratchVec[1];
    out[10] = -scratchVec[2];
    out[14] = 0.0;
    out[3] = 0.0;
    out[7] = 0.0;
    out[11] = 0.0;
    out[15] = 1.0;
    return out;
}
