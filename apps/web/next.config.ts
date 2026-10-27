import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  { key: "Cache-Control", value: "no-store" },
  {
    key: "Content-Security-Policy",
    value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'") + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: https://*.amazonaws.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
  },
];

const config: NextConfig = {
  transpilePackages: ["@aba/core", "@aba/config"],
  serverExternalPackages: ["pg", "unpdf", "@napi-rs/canvas", "exceljs", "mammoth", "docx", "docxtemplater", "pizzip", "bcryptjs"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
