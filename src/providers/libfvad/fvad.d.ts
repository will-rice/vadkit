// Hand-written declarations for the generated Emscripten module (fvad.js).
// Regenerate the module with scripts/build_libfvad.sh.

export interface FvadModule {
  _fvad_new(): number;
  _fvad_free(instance: number): void;
  _fvad_reset(instance: number): void;
  _fvad_set_mode(instance: number, mode: number): number;
  _fvad_set_sample_rate(instance: number, sampleRate: number): number;
  _fvad_process(instance: number, frame: number, length: number): number;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  HEAP16: Int16Array;
}

export default function createFvadModule(): Promise<FvadModule>;
