import { useCallback, useEffect, useRef, useState } from 'react';
import { getSummary } from '../api';
import { Metric } from '../components/StatusBits';

/**
 * The door screen: live camera view using WebRTC getUserMedia.
 *
 * Optimized for entry-level smartphones:
 * - Forces environment (rear) camera
 * - Limited to 640x480 resolution and 15 FPS to prevent battery drain
 * - Uses browser-native WebRTC instead of Python backend processing
 */

/** What to say when there's no picture, in words that suggest what to do. */
function Placeholder({ reason }) {
  const messages = {
    permission_denied: {
      title: 'Camera access denied',
      body: 'Please allow camera access to view the door. This is needed for the live feed.',
    },
    no_camera: {
      title: 'No camera found',
      body: 'Your device doesn\'t have a camera or it\'s not available.',
    },
    stream_error: {
      title: 'Camera error',
      body: 'The camera couldn\'t be started. Try refreshing the page.',
    },
    loading: {
      title: 'Starting camera',
      body: 'Opening the rear camera view...',
    },
  };
  const { title, body } = messages[reason] || messages.loading;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-8 text-center">
      <p className="text-base font-medium text-slate-200">{title}</p>
      <p className="mt-2 max-w-md text-sm text-slate-400">{body}</p>
    </div>
  );
}

export default function DoorCamera() {
  const [streamState, setStreamState] = useState('loading');
  const [summary, setSummary] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const startCamera = useCallback(async () => {
    if (!enabled) return;

    setStreamState('loading');
    
    try {
      // Stop existing stream if any
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: 'environment' },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 15 },
        },
      });
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play();
          setStreamState('active');
        };
      }
    } catch (error) {
      console.error('Camera error:', error);
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setStreamState('permission_denied');
      } else if (error.name === 'NotFoundError') {
        setStreamState('no_camera');
      } else {
        setStreamState('stream_error');
      }
    }
  }, [enabled]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      startCamera();
    } else {
      stopCamera();
      setStreamState('loading');
    }

    return () => {
      stopCamera();
    };
  }, [enabled, startCamera, stopCamera]);

  useEffect(() => {
    const load = () => getSummary().then(setSummary).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const toggle = () => {
    setEnabled(!enabled);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">At the door</h1>
          <p className="mt-1 text-sm text-slate-600">
            Live camera view using your device's rear camera.
          </p>
        </div>

        <button
          type="button"
          onClick={toggle}
          aria-pressed={enabled}
          className={`rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors min-h-[44px] min-w-[44px] ${
            enabled
              ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
          }`}
        >
          {enabled ? 'Turn camera off' : 'Turn camera on'}
        </button>
      </header>

      <div className="relative w-full overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: '4/3' }}>
        {/* Always mounted so videoRef exists when startCamera() attaches the stream;
            visibility is toggled instead of conditionally rendering the element. */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${
            enabled && streamState === 'active' ? '' : 'hidden'
          }`}
        />
        {!(enabled && streamState === 'active') && <Placeholder reason={streamState} />}
      </div>

      {enabled && streamState === 'active' && (
        <p className="text-sm text-slate-600">
          Camera is active. This view shows the entrance in real-time.
        </p>
      )}

      {!enabled && (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Camera is paused. The register is still working in the background.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Guests" value={summary?.total_guests} />
        <Metric label="In" value={summary?.currently_in} />
        <Metric label="Out" value={summary?.currently_out} />
      </div>
    </div>
  );
}
