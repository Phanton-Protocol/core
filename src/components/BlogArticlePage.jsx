import { Link } from "react-router-dom";
import Navbar from "./Navbar";
import SeoHead from "./SeoHead";

export default function BlogArticlePage({ title, description, path, date, readTime, intro, sections, pdfHref, pdfLabel }) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <SeoHead title={title} description={description} path={path} />
      <Navbar />
      <section className="section" style={{ paddingTop: "7rem" }}>
        <div className="container" style={{ maxWidth: 860 }}>
          <div className="section-label">Phantom Blog</div>
          <h1 className="display-lg" style={{ marginBottom: "0.75rem" }}>{title}</h1>
          <p className="mono" style={{ color: "rgba(255,255,255,0.6)", marginBottom: "1.5rem" }}>
            {date} · {readTime}
          </p>
          <p style={{ color: "rgba(255,255,255,0.92)", lineHeight: 1.8, marginBottom: "1.5rem" }}>{intro}</p>
          {sections.map((section) => (
            <div key={section.heading} style={{ marginBottom: "1.6rem" }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.9rem", marginBottom: "0.65rem" }}>{section.heading}</h2>
              <p style={{ color: "rgba(255,255,255,0.86)", lineHeight: 1.8 }}>{section.body}</p>
            </div>
          ))}
          <div style={{ marginTop: "2rem", display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
            {pdfHref ? (
              <a href={pdfHref} className="btn-outline btn-outline-cyan" target="_blank" rel="noopener noreferrer">
                {pdfLabel || "Download PDF"}
              </a>
            ) : null}
            <Link to="/blog" className="btn-outline">All Articles</Link>
            <Link to="/trade" className="btn-outline btn-outline-cyan">Try InternalMatching</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
