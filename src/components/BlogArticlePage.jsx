import { Link } from "react-router-dom";
import Navbar from "./Navbar";
import SeoHead from "./SeoHead";

function SectionBody({ section }) {
  const raw = section.body;
  const paras = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const nonEmpty = paras.filter((p) => typeof p === "string" && p.length > 0);
  return (
    <>
      {nonEmpty.map((p, i) => (
        <p key={i} style={{ color: "rgba(255,255,255,0.86)", lineHeight: 1.8, marginBottom: "1rem" }}>{p}</p>
      ))}
      {section.pullQuote ? (
        <blockquote
          style={{
            margin: "1.25rem 0",
            padding: "1rem 1.25rem",
            borderLeft: "3px solid var(--color-accent-primary)",
            background: "rgba(0, 229, 199, 0.06)",
            fontStyle: "italic",
            color: "rgba(255,255,255,0.9)",
            lineHeight: 1.75,
          }}
        >
          {section.pullQuote}
        </blockquote>
      ) : null}
      {section.bullets?.length ? (
        <ul style={{ color: "rgba(255,255,255,0.86)", lineHeight: 1.75, margin: "0 0 1rem", paddingLeft: "1.25rem" }}>
          {section.bullets.map((item, bi) => (
            <li key={bi} style={{ marginBottom: "0.5rem" }}>{item}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export default function BlogArticlePage({ title, description, path, date, readTime, intro, introFigure, sections }) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <SeoHead title={title} description={description} path={path} />
      <Navbar />
      <section className="section" style={{ paddingTop: "7rem" }}>
        <article className="container blog-epaper" style={{ maxWidth: 920 }}>
          <div className="section-label">Phantom Blog</div>
          <h1 className="display-lg" style={{ marginBottom: "0.75rem" }}>{title}</h1>
          <p className="mono" style={{ color: "rgba(255,255,255,0.6)", marginBottom: "1.5rem" }}>
            {date} · {readTime}
          </p>
          {introFigure?.src ? (
            <figure style={{ margin: "0 0 1.5rem" }}>
              <img
                src={introFigure.src}
                alt={introFigure.alt || ""}
                loading="eager"
                decoding="async"
                className={introFigure.wide ? "blog-figure-wide" : undefined}
                style={{
                  width: "100%",
                  maxWidth: introFigure.wide ? "100%" : 560,
                  height: "auto",
                  display: "block",
                  margin: introFigure.wide ? "0 auto" : "0 auto",
                  borderRadius: 10,
                  border: "1px solid var(--color-border)",
                  boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
                }}
              />
            </figure>
          ) : null}
          <p style={{ color: "rgba(255,255,255,0.92)", lineHeight: 1.8, marginBottom: "1.5rem" }}>{intro}</p>
          {sections.map((section, idx) => (
            <div key={`${section.heading}-${idx}`} style={{ marginBottom: "2.25rem" }}>
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
                      maxWidth: section.figureMaxWidth || 640,
                      height: "auto",
                      display: "block",
                      margin: "0 auto",
                      borderRadius: 10,
                      border: "1px solid var(--color-border)",
                      boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
                    }}
                  />
                </figure>
              ) : null}
              <SectionBody section={section} />
            </div>
          ))}
          <div style={{ marginTop: "2rem", display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
            <Link to="/blog" className="btn-outline">All Articles</Link>
            <Link to="/trade" className="btn-outline btn-outline-cyan">Try InternalMatching</Link>
          </div>
        </article>
        <style>{`
          .blog-epaper .blog-figure-wide { max-width: 100% !important; }
        `}</style>
      </section>
    </div>
  );
}
