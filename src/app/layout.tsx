import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Device Tree Visualizer",
  description:
    "Browse device tree source and flattened blobs. Inspect nodes, properties, labels, and overlays.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full bg-background text-foreground">
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{if(localStorage.getItem("dt-theme")==="light")document.documentElement.classList.remove("dark")}catch(e){}',
          }}
        />
        {children}
      </body>
    </html>
  );
}
