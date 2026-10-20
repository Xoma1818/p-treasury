import { create } from "zustand";
import type { SectionId } from "./sections";

interface UiState {
  section: SectionId;
  go: (section: SectionId) => void;
}

export const useUi = create<UiState>((set) => ({
  section: "home",
  go: (section) => set({ section }),
}));
