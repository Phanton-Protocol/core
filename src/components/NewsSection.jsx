import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { blogPosts } from '../data/blogPosts';

const MotionLink = motion(Link);

const NewsSection = () => {
    const newsItems = blogPosts.slice(0, 3);

    return (
        <section className="section" id="blog">
            <div className="container">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '4rem', flexWrap: 'wrap', gap: '2rem' }}>
                    <div>
                        <div className="section-label">Blog</div>
                        <h2 className="display-lg">
                            Latest<br /><em>articles.</em>
                        </h2>
                    </div>
                    <Link to="/blog" className="btn-outline">
                        View all articles
                    </Link>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {newsItems.map((news, idx) => (
                        <MotionLink
                            to={`/blog/${news.slug}`}
                            key={news.slug}
                            initial={{ opacity: 0, y: 20 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: idx * 0.1, duration: 0.6 }}
                            className="hover-underline"
                            style={{
                                display: 'grid',
                                gridTemplateColumns: 'minmax(120px, 1fr) 3fr',
                                gap: '2rem',
                                padding: '2.5rem 0',
                                borderTop: idx === 0 ? '1px solid var(--border)' : '1px solid rgba(255,255,255,0.03)',
                                textDecoration: 'none',
                                color: 'var(--text-primary)',
                                alignItems: 'start'
                            }}
                        >
                            <div className="mono text-muted">
                                <span style={{ color: 'var(--cyan)', display: 'block', marginBottom: '0.25rem' }}>[{news.category}]</span>
                                {news.date}
                            </div>
                            <div>
                                <h3 style={{
                                    fontFamily: 'var(--font-display)',
                                    fontSize: '1.75rem',
                                    fontWeight: 400,
                                    marginBottom: '1rem',
                                }}>
                                    {news.title}
                                </h3>
                                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, maxWidth: '600px' }}>
                                    {news.excerpt}
                                </p>
                            </div>
                        </MotionLink>
                    ))}
                    <div className="divider" />
                </div>
            </div>
        </section>
    );
};

export default NewsSection;
