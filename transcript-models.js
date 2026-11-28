// Unmix — the Whisper models offered in the transcription picker.
// Sizes are rough first estimates (MB); the app replaces them with exact sizes when it can.

export const MODELS = [
  {
    id: 'tiny', name: 'Tiny', repo: 'onnx-community/whisper-tiny_timestamped',
    speed: 5, accuracy: 1, words: 'precise',
    est: { gpu: 115, cpu: 45 },
    rtf: { gpu: 40, cpu: 6 },          // seconds of audio per second of work (first guess)
    blurb: 'Fastest and runs on almost anything, phones included. Good for a quick rough transcript of clear speech. Expect mistakes with accents, names and music.'
  },
  {
    id: 'base', name: 'Base', repo: 'onnx-community/whisper-base_timestamped',
    speed: 4, accuracy: 2, words: 'precise',
    est: { gpu: 210, cpu: 80 },
    rtf: { gpu: 30, cpu: 3 },
    blurb: 'Still fast, a bit more accurate. Fine for clean voiceovers and good on older laptops.'
  },
  {
    id: 'small', name: 'Small', repo: 'onnx-community/whisper-small_timestamped',
    speed: 3, accuracy: 3, words: 'precise',
    est: { gpu: 510, cpu: 250 },
    rtf: { gpu: 12, cpu: 1 },
    blurb: 'The sweet spot for most laptops. Noticeably better with accents, names and punctuation.'
  },
  {
    id: 'medium', name: 'Medium', repo: 'Xenova/whisper-medium',
    speed: 2, accuracy: 4, words: 'estimated',
    est: { gpu: 1530, cpu: 780 },
    rtf: { gpu: 4, cpu: 0.25 },
    blurb: 'Strong accuracy for interviews and harder audio, but slow without a good graphics card.'
  },
  {
    id: 'turbo', name: 'Large-v3 Turbo', repo: 'onnx-community/whisper-large-v3-turbo',
    speed: 3, accuracy: 5, words: 'estimated',
    est: { gpu: 1600, cpu: 1090 },
    rtf: { gpu: 8, cpu: 0.3 },
    blurb: 'Close to the best accuracy at much better speed than full Large. Ideal on a strong graphics card, and the one for final captions.'
  }
];

export const modelById = (id) => MODELS.find((m) => m.id === id);

// Which weight formats to try, in order, for each kind of device.
// gpu16 = graphics card that supports half precision, gpu = one that doesn't, cpu = no usable GPU.
export function dtypeOptions(model, kind) {
  const E = 'encoder_model', D = 'decoder_model_merged';
  const q8 = { [E]: 'q8', [D]: 'q8' };
  if (kind === 'cpu') return [q8];
  if (model.id === 'turbo') {
    return kind === 'gpu16'
      ? [{ [E]: 'fp16', [D]: 'q4' }, { [E]: 'fp16', [D]: 'fp16' }, q8]
      : [{ [E]: 'q4', [D]: 'q4' }, q8];
  }
  if (model.id === 'medium') {
    return kind === 'gpu16' ? [{ [E]: 'fp16', [D]: 'fp16' }, q8] : [q8];
  }
  return [{ [E]: 'fp32', [D]: 'q4' }, { [E]: 'fp32', [D]: 'q8' }, q8];
}

// Languages Whisper understands well enough to offer (code → name).
export const LANGUAGES = [
  ['', 'Auto-detect'], ['en', 'English'], ['fr', 'French'], ['es', 'Spanish'], ['pt', 'Portuguese'],
  ['de', 'German'], ['it', 'Italian'], ['nl', 'Dutch'], ['ar', 'Arabic'], ['ha', 'Hausa'], ['yo', 'Yoruba'],
  ['sw', 'Swahili'], ['sn', 'Shona'], ['so', 'Somali'], ['af', 'Afrikaans'], ['ln', 'Lingala'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['hi', 'Hindi'], ['ru', 'Russian'],
  ['tr', 'Turkish'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['id', 'Indonesian'], ['vi', 'Vietnamese']
];
