import type { Metadata } from "next";

import Coach from "./Coach";

export const metadata: Metadata = {
  title: "Chess Coach",
};

export default function CoachPage() {
  return <Coach />;
}
