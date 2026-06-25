import React, { useEffect } from "react";
import { Provider } from "react-redux";
import { store } from "../store/store";
import { setGatewayReady, setGatewayRestarting, setGatewayFailed } from "../store/slices/gatewaySlice";
import { AppStateProvider } from "./appState";
import { Shell } from "./layout/Shell";

type Ports = { api: number; mo: number | null };

function activate(ports: Ports) {
  if (ports?.api > 0) store.dispatch(setGatewayReady({ port: ports.api, moPort: ports.mo }));
}

export function App() {
  useEffect(() => {
    const api = (window as any).moAPI;
    if (!api) return;

    const unsubReady = api.onPythonReady?.((ports: Ports) => activate(ports));
    const unsubRestart = api.onPythonRestarting?.(() => store.dispatch(setGatewayRestarting()));
    const unsubError = api.onPythonError?.((err: string) => store.dispatch(setGatewayFailed(err)));

    // Poll as a safety net — covers the race between the IPC event and the
    // renderer subscription, AND the case where the API port is verified before
    // the dashboard (mo) port binds: the first python-ready can carry mo=null,
    // so keep polling and re-activate until BOTH ports are known.
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const st = store.getState().gateway.state;
      if (st.kind === "ready" && st.moPort) return;
      try {
        const ports: Ports | null = await api.getPorts?.();
        if (ports?.api) activate(ports); // re-dispatch picks up a late mo port
      } catch { /* IPC not ready */ }
      setTimeout(tick, 2000);
    };
    tick();

    return () => { stopped = true; unsubReady?.(); unsubRestart?.(); unsubError?.(); };
  }, []);

  return (
    <Provider store={store}>
      <AppStateProvider>
        <Shell />
      </AppStateProvider>
    </Provider>
  );
}
