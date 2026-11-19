// Small store the navbar status chip reads: pages report driver online state and ask the chip to
// refresh (e.g. after a trip completes) without prop-drilling through the layout.
import { useSyncExternalStore } from 'react';

let state = { driverOnline: null, version: 0 };
const subs = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  subs.forEach((fn) => fn());
};

export const setNavDriverOnline = (online) => state.driverOnline !== online && set({ driverOnline: online });
export const refreshNavStatus = () => set({ version: state.version + 1 });

export function useNavStatus() {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}
