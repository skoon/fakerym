// ---------------------------------------------------------------- shared GLSL
// The water and grass materials are hand-written, so they miss three's fog chunks and have to
// reproduce FogExp2 themselves. One copy, used by both.
export const FOG_VERT = /* glsl */`varying float vFog;`;

export const FOG_FRAG = /* glsl */`
  uniform vec3 fogColor; uniform float fogDensity;
  varying float vFog;
  vec3 fogged(vec3 c){
    float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);
    return mix(c, fogColor, f);
  }`;

// Shares scene.fog's Color instance, so the uniform tracks the day/night tint with no per-frame
// copy. Density is a number and does have to be pushed — see syncFog.
export const fogUniforms = fog => ({
  fogColor: { value: fog.color },
  fogDensity: { value: fog.density }
});

export const syncFog = (mat, fog) => { mat.uniforms.fogDensity.value = fog.density; };
