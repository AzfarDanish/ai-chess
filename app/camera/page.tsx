import type { Metadata } from "next";

import CameraStream from "./CameraStream";

export const metadata: Metadata = {
  title: "Camera",
};

export default function CameraPage() {
  return <CameraStream />;
}
