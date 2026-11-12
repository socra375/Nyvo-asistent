import { useEffect, useMemo, useState } from 'react';
import { Panel } from '../hud/Panel';
import type { VoiceConfig } from '../lib/api';
import { browserVoiceSupported, loadVoices } from '../voice/browserVoice';
import { DEFAULT_PREFS, RATE_RANGE, sortBrowserVoices, type BrowserVoiceInfo, type VoicePrefs } from '../voice/voicePrefs';
import { speak } from '../voice/useVoice';

const SAMPLE = 'Hola, soy Nyvo, el segundo director de AINova. Así suena mi voz.';

/** Las voces que ofrece este equipo: las instaladas en la PC (del sistema) y las en línea del navegador. */
function useBrowserVoices(): BrowserVoiceInfo[] {
  const [voices, setVoices] = useState<BrowserVoiceInfo[]>([]);
  useEffect(() => {
    if (!browserVoiceSupported()) return;
    let alive = true;
    const read = () => { if (alive) setVoices(window.speechSynthesis.getVoices().map(v => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService }))); };
    void loadVoices().then(read);
    window.speechSynthesis.addEventListener('voiceschanged', read);
    return () => { alive = false; window.speechSynthesis.removeEventListener('voiceschanged', read); };
  }, []);
  return voices;
}

interface Props { config: VoiceConfig | null; prefs: VoicePrefs; setPrefs: (p: VoicePrefs) => void; notify: (m: string, err?: boolean) => void }

/** Elegir con qué voz habla Nyvo: la del servicio configurado, o cualquiera de las voces de la PC y del navegador. */
export function Voices({ config, prefs, setPrefs, notify }: Props) {
  const browserVoices = useBrowserVoices();
  const { spanish, other } = useMemo(() => sortBrowserVoices(browserVoices), [browserVoices]);
  const serverOk = !!config && config.provider !== 'navegador' && !config.missingEnv.length && (config.voices?.length ?? 0) > 0;
  const [testing, setTesting] = useState(false);
  // Qué está marcado: la voz del servidor, una del navegador, o «automática» (la mejor en español, elegida sola).
  const usingServer = serverOk && prefs.engine !== 'navegador';
  const set = (patch: Partial<VoicePrefs>) => setPrefs({ ...prefs, ...patch });

  const test = async () => {
    setTesting(true);
    try { await speak(SAMPLE, undefined, config?.provider, prefs); }
    catch (e) { notify(e instanceof Error ? e.message : String(e), true); }
    finally { setTesting(false); }
  };

  const voiceRow = (v: BrowserVoiceInfo) => (
    <label key={v.voiceURI} className="voice-row">
      <input type="radio" name="voz" checked={!usingServer && prefs.browserURI === v.voiceURI} onChange={() => set({ engine: 'navegador', browserURI: v.voiceURI })} />
      <span className="voice-name">{v.name}</span>
      <span className="voice-meta">{v.lang}</span>
    </label>
  );
  const local = spanish.filter(v => v.localService);
  const online = spanish.filter(v => !v.localService);

  return (
    <Panel id="panel-voces" title="Voces" tag="PC · NAVEGADOR · SERVICIO">
      <p className="voice-intro">Elige con qué voz te habla Nyvo. Se recuerda en este navegador y suena desde la siguiente respuesta.</p>

      {serverOk && (
        <fieldset className="voice-group" aria-label="Voces del servicio">
          <legend>Voz de Nyvo ({config!.provider})</legend>
          <div className="voice-list" role="radiogroup" aria-label="Voces del servicio">
            {config!.voices!.map(v => (
              <label key={v.id} className="voice-row">
                <input type="radio" name="voz" checked={usingServer && (prefs.serverVoice ?? config!.voices!.find(x => x.default)?.id) === v.id}
                  onChange={() => set({ engine: 'servidor', serverVoice: v.default ? null : v.id })} />
                <span className="voice-name">{v.name}</span>
                {v.default && <span className="voice-meta">predeterminada</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="voice-group" aria-label="Voces de la PC y del navegador">
        <legend>Voces de la PC y del navegador</legend>
        {!browserVoiceSupported() ? <div className="empty">Este navegador no trae voces propias.</div> : (
          <div className="voice-list" role="radiogroup" aria-label="Voces de la PC y del navegador">
            <label className="voice-row">
              <input type="radio" name="voz" checked={!usingServer && prefs.browserURI === null} onChange={() => set({ engine: 'navegador', browserURI: null })} />
              <span className="voice-name">Automática</span>
              <span className="voice-meta">la mejor voz en español</span>
            </label>
            {local.length > 0 && <div className="voice-sub">Instaladas en la PC</div>}
            {local.map(voiceRow)}
            {online.length > 0 && <div className="voice-sub">En línea (del navegador)</div>}
            {online.map(voiceRow)}
            {spanish.length === 0 && <div className="empty">No hay voces en español en este equipo: se usará la del sistema.</div>}
            {other.length > 0 && (
              <details className="voice-other">
                <summary>Otros idiomas ({other.length})</summary>
                {other.map(voiceRow)}
              </details>
            )}
          </div>
        )}
      </fieldset>

      <div className="voice-sliders">
        <label>Velocidad <output>{prefs.rate.toFixed(2)}×</output>
          <input type="range" min={RATE_RANGE.min} max={RATE_RANGE.max} step={0.02} value={prefs.rate} disabled={usingServer}
            onChange={e => set({ rate: Number(e.target.value) })} aria-label="Velocidad de la voz" />
        </label>
        <label>Volumen <output>{Math.round(prefs.volume * 100)} %</output>
          <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={e => set({ volume: Number(e.target.value) })} aria-label="Volumen de la voz" />
        </label>
        {usingServer && <p className="voice-note">La velocidad se ajusta en las voces de la PC y del navegador; la del servicio habla a su ritmo.</p>}
      </div>

      <div className="row">
        <button type="button" className="btn small primary" onClick={test} disabled={testing}>{testing ? 'Hablando…' : 'Probar voz'}</button>
        <button type="button" className="btn small ghost" onClick={() => setPrefs({ ...DEFAULT_PREFS })}>Restablecer</button>
      </div>
    </Panel>
  );
}
