import "./globals.css";

export const metadata = {
  title: "AI Agent Certification Platform",
  description: "Live AI-conducted voice certification for contact-center agents with screen recording and AI evaluation.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
