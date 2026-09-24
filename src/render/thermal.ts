/**
 * Shared shader uniforms + a material patch that swaps shading for a heat value in
 * THERMAL view (the grade pass then maps luminance to an ironbow palette).
 */
import * as THREE from 'three';

export const GLOBAL = {
  uThermal: { value: 0 },
  uTime: { value: 0 },
  uJev: { value: 0 },
};

/** Patch a built-in material: in thermal mode it outputs a constant heat level. */
export function applyThermal<T extends THREE.Material>(mat: T, heat: number): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    shader.uniforms.uThermal = GLOBAL.uThermal;
    shader.uniforms.uHeat = { value: heat };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uThermal; uniform float uHeat;\nvoid main() {')
      .replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n if (uThermal > 0.5) { gl_FragColor.rgb = vec3(uHeat) * (0.85 + 0.15 * gl_FragColor.g); }',
      );
  };
  mat.customProgramCacheKey = () => `thermal-${heat}-${mat.type}`;
  return mat;
}
