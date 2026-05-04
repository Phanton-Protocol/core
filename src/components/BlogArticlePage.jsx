import { Link } from "react-router-dom";
import Navbar from "./Navbar";
import SeoHead from "./SeoHead";

export default function BlogArticlePage({ title, description, path, date, readTime, intro, sections }) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <SeoHead title={title} description={description} path={path} />
      <Navbar />
      <section className="section" style={{ paddingTop: "7rem" }}>
        <div className="container" style={{ maxWidth: 920 }}>
          <div className="section-label">Phantom Blog</div>
          <h1 className="display-lg" style={{ marginBottom: "0.75rem" }}>{title}</h1>
          <p className="mono" style={{ color: "rgba(255,255,255,0.6)", marginBottom: "1.5rem" }}>
            {date} · {readTime}
          </p>
          <p style={{ color: "rgba(255,255,255,0.92)", lineHeight: 1.8, marginBottom: "1.5rem" }}>{intro}</p>
          {sections.map((section, idx) => (
            <div key={`${section.heading}-${idx}`} style={{ marginBottom: "2rem" }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.9rem", marginBottom: "0.75rem" }}>{section.heading}</h2>
              {section.figureSrc ? (
                <figure style={{ margin: "0 0 1.25rem" }}>
                  <img
                    src={section.figureSrc}
                    alt={section.figureAlt || section.heading}
                    loading="lazy"
                    decoding="async"
                    style={{
                      width: "100%",
                      height: "auto",
                      display: "block",
                      borderRadius: 10,
                      border: "1px solid var(--color-border)",
                      boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
                    }}
                  />
                </figure>
              ) : null}
              <p style={{ color: "rgba(255,255,255,0.86)", lineHeight: 1.8 }}>{section.body}</p>
            </div>
          ))}
          <div style={{ marginTop: "2rem", display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
            <Link to="/blog" className="btn-outline">All Articles</Link>
            <Link to="/trade" className="btn-outline btn-outline-cyan">Try InternalMatching</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
