import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { Enter3D } from './motion.jsx';

const ToastContext = createContext(() => {});
const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
const COLORS = { success: 'var(--success)', error: 'var(--danger)', info: 'var(--primary)', warning: 'var(--warning)' };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, type = 'info', title) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, message, type, title }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 6000 : 4500);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = ICONS[t.type] || Info;
          return (
            <Enter3D key={t.id} className={`toast ${t.type}`} from={{ rotationX: -90, y: -10, x: 40 }}>
              <Icon size={20} color={COLORS[t.type]} style={{ flexShrink: 0 }} />
              <div>
                {t.title && <div className="bold">{t.title}</div>}
                <div className={t.title ? 'text-2 small' : ''}>{t.message}</div>
              </div>
            </Enter3D>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useToast = () => useContext(ToastContext);
