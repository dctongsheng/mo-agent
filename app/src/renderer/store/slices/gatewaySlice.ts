import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type GatewayState =
  | { kind: "starting" }
  | { kind: "restarting" }
  | { kind: "ready"; port: number; moPort: number | null }
  | { kind: "failed"; error: string };

type SliceState = { state: GatewayState };

const slice = createSlice({
  name: "gateway",
  initialState: { state: { kind: "starting" } } as SliceState,
  reducers: {
    setGatewayReady: (state, a: PayloadAction<{ port: number; moPort: number | null }>) => {
      state.state = { kind: "ready", port: a.payload.port, moPort: a.payload.moPort };
    },
    setGatewayFailed: (state, a: PayloadAction<string>) => {
      state.state = { kind: "failed", error: a.payload };
    },
    setGatewayRestarting: (state) => { state.state = { kind: "restarting" }; },
  },
});

export const { setGatewayReady, setGatewayFailed, setGatewayRestarting } = slice.actions;
export const gatewayReducer = slice.reducer;

/** Convenience: returns the API port if ready, else 0. */
export const apiPortOf = (s: GatewayState): number => (s.kind === "ready" ? s.port : 0);
export const moPortOf = (s: GatewayState): number => (s.kind === "ready" && s.moPort ? s.moPort : 0);
