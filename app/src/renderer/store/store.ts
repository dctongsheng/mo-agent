import { configureStore } from "@reduxjs/toolkit";
import { gatewayReducer } from "./slices/gatewaySlice";

export const store = configureStore({
  reducer: {
    gateway: gatewayReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
