export const LOG_EVENT_TYPES = [
    'error',
    'session.created',
    'response.audio.delta',
    'response.audio_transcript.done',
    'conversation.item.input_audio_transcription.completed',
];

export const DYNAMIC_API_SECRET = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
export const SHOW_TIMING_MATH = false;
export const VOICE = 'sage';
export const RECORD_CALLS = process.env.RECORD === 'true';
export const GOODBYE_PHRASES = ['bye', 'goodbye', 'have a nice day', 'have a great day', 'see you', 'take care', 'thank you'];
