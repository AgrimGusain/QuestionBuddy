import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["sharp"],
  allowedDevOrigins: ["192.168.56.1"], // your Wi-Fi IPv4 from ipconfig
};

export default nextConfig;
