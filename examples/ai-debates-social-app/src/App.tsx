import { useMemo, useState } from 'react'
import './App.css'

type DebateLine = {
  speaker: string
  role: string
  text: string
}

type Person = {
  name: string
  avatarUrl: string
  descriptor: string
}

type RelatedItem = {
  id: string
  source: 'X' | 'Reddit' | 'News'
  headline: string
  excerpt: string
  meta: string
}

type DebateCard = {
  id: string
  category: string
  title: string
  hook: string
  audience: string
  leftPerson: Person
  rightPerson: Person
  likes: number
  replies: number
  reposts: number
  transcript: DebateLine[]
  related: RelatedItem[]
}

type Comment = {
  id: string
  author: string
  handle: string
  text: string
  likes: number
}

type TabId = 'arena' | 'trending' | 'rankings' | 'settings'

type RankingEntry = {
  name: string
  avatarUrl: string
  wins: number
  total: number
}

function Avatar({
  src,
  alt,
  className,
  fallback,
}: {
  src: string
  alt: string
  className: string
  fallback: string
}) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return <div className={`${className} avatar-fallback`}>{fallback}</div>
  }

  return <img className={className} src={src} alt={alt} onError={() => setFailed(true)} />
}

const debates: DebateCard[] = [
  {
    id: 'nietzsche-vs-peterson',
    category: 'Meaning',
    title: 'Can modern life still give people real meaning?',
    hook: 'Nietzsche vs Jordan Peterson',
    audience: '28.4k listening now',
    leftPerson: {
      name: 'Friedrich Nietzsche',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Nietzsche187a.jpg/330px-Nietzsche187a.jpg',
      descriptor: 'philosopher of rupture',
    },
    rightPerson: {
      name: 'Jordan Peterson',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Jordan_Peterson_in_2018_%283x4_cropped%29.jpg/330px-Jordan_Peterson_in_2018_%283x4_cropped%29.jpg',
      descriptor: 'psychologist of order',
    },
    likes: 18200,
    replies: 3900,
    reposts: 1200,
    transcript: [
      {
        speaker: 'Host',
        role: 'Opening',
        text: 'Tonight the question is whether modern people can still build a life that feels deeply meaningful, or whether meaning has become a fragile performance in an age of distraction.',
      },
      {
        speaker: 'Friedrich Nietzsche',
        role: 'First strike',
        text: 'Modern people say they want meaning, but what they often want is comfort with decoration. Meaning begins where imitation ends. A person must create values, not inherit a script and call obedience depth.',
      },
      {
        speaker: 'Jordan Peterson',
        role: 'Response',
        text: 'That sounds dramatic, but people do not stabilize themselves through endless reinvention. Meaning is found in responsibility, truth, sacrifice, and voluntarily carrying the burden of existence despite suffering.',
      },
      {
        speaker: 'Friedrich Nietzsche',
        role: 'Counter',
        text: 'Responsibility can become another name for tameness. I am suspicious of any moral language that flatters weakness by calling it virtue.',
      },
      {
        speaker: 'Jordan Peterson',
        role: 'Close',
        text: 'And I am suspicious of any philosophy that celebrates transcendence without asking whether ordinary people can actually live inside it without collapse.',
      },
    ],
    related: [
      {
        id: 'n1',
        source: 'X',
        headline: '“Nietzsche would hate self-help culture but still understand why it exists.”',
        excerpt: 'A viral post thread arguing that modern meaning has become branding with better lighting.',
        meta: '14.2k likes',
      },
      {
        id: 'n2',
        source: 'Reddit',
        headline: 'r/philosophy: Is meaning discovered or built?',
        excerpt: 'Hundreds of comments debating whether structure gives life purpose or cages it.',
        meta: '1.8k comments',
      },
      {
        id: 'n3',
        source: 'News',
        headline: 'Why “purpose anxiety” became a defining mood of online life',
        excerpt: 'An essay on self-optimization, burnout, and the social pressure to feel significant.',
        meta: '12 min read',
      },
    ],
  },
  {
    id: 'jobs-vs-musk',
    category: 'Technology',
    title: 'Does great technology come from obsession or speed?',
    hook: 'Steve Jobs vs Elon Musk',
    audience: '41.2k watching now',
    leftPerson: {
      name: 'Steve Jobs',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Steve_Jobs_Headshot_2010-CROP_%28cropped_2%29.jpg/330px-Steve_Jobs_Headshot_2010-CROP_%28cropped_2%29.jpg',
      descriptor: 'product perfectionist',
    },
    rightPerson: {
      name: 'Elon Musk',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Elon_Musk_-_54820081119_%28cropped%29.jpg/330px-Elon_Musk_-_54820081119_%28cropped%29.jpg',
      descriptor: 'scale-driven builder',
    },
    likes: 24700,
    replies: 5600,
    reposts: 2100,
    transcript: [
      {
        speaker: 'Host',
        role: 'Opening',
        text: 'This room asks a founder question people never stop debating: do iconic products come from ruthless taste or ruthless speed?',
      },
      {
        speaker: 'Steve Jobs',
        role: 'Opening take',
        text: 'People think technology is about features. It is not. It is about taste, focus, and the discipline to remove what does not belong until the product feels inevitable.',
      },
      {
        speaker: 'Elon Musk',
        role: 'Counter',
        text: 'That is fine if the market waits for your elegance. Sometimes the point is not refinement first. Sometimes the point is to build the future before anyone else has the courage or stamina to do it.',
      },
      {
        speaker: 'Steve Jobs',
        role: 'Pushback',
        text: 'Moving fast does not excuse shipping mediocrity. Most complexity in technology is self-inflicted by teams that mistake velocity for clarity.',
      },
      {
        speaker: 'Elon Musk',
        role: 'Close',
        text: 'And most impossible things stay impossible because people polish the doorway instead of walking through it.',
      },
    ],
    related: [
      {
        id: 't1',
        source: 'X',
        headline: '“The Jobs school says delete features. The Musk school says delete excuses.”',
        excerpt: 'A founder thread comparing craft-led companies with mission-led companies.',
        meta: '22.1k likes',
      },
      {
        id: 't2',
        source: 'Reddit',
        headline: 'r/startups: Taste vs speed in product building',
        excerpt: 'Operators debate whether early-stage startups should optimize for delight or velocity.',
        meta: '926 comments',
      },
      {
        id: 't3',
        source: 'News',
        headline: 'Why founder mythology keeps splitting between design and scale',
        excerpt: 'A feature on two rival visions of what makes a company feel inevitable.',
        meta: '9 min read',
      },
    ],
  },
  {
    id: 'marx-vs-friedman',
    category: 'Power',
    title: 'Does capitalism reward talent or concentrate power?',
    hook: 'Karl Marx vs Milton Friedman',
    audience: '33.8k in this room',
    leftPerson: {
      name: 'Karl Marx',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Karl_Marx_001.jpg/330px-Karl_Marx_001.jpg',
      descriptor: 'critic of capital',
    },
    rightPerson: {
      name: 'Milton Friedman',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Portrait_of_Milton_Friedman_%284x5_cropped%29.jpg/330px-Portrait_of_Milton_Friedman_%284x5_cropped%29.jpg',
      descriptor: 'champion of markets',
    },
    likes: 19300,
    replies: 7200,
    reposts: 1800,
    transcript: [
      {
        speaker: 'Host',
        role: 'Opening',
        text: 'Few matchups are cleaner than this one: is capitalism the best system for freedom, or the most persuasive system for disguising domination?',
      },
      {
        speaker: 'Karl Marx',
        role: 'Opening take',
        text: 'Capitalism celebrates freedom while organizing dependency. It praises merit while quietly rewarding ownership over labor. It is a machine for turning human effort into private power.',
      },
      {
        speaker: 'Milton Friedman',
        role: 'Response',
        text: 'Markets are not moral theater. They are coordination systems. They allow millions of people to act, choose, exchange, and innovate without waiting for centralized permission.',
      },
      {
        speaker: 'Karl Marx',
        role: 'Counter',
        text: 'That language always forgets who begins with property, leverage, and inherited advantage. Voluntary exchange between unequals is often just inequality with better branding.',
      },
      {
        speaker: 'Milton Friedman',
        role: 'Close',
        text: 'And hostility to markets usually ends with concentrated state power pretending it has solved concentrated private power.',
      },
    ],
    related: [
      {
        id: 'p1',
        source: 'X',
        headline: '“Every generation rediscovers Marx the moment rent eats half their paycheck.”',
        excerpt: 'A widely shared post about inequality, aspiration, and who capitalism feels designed for.',
        meta: '18.9k likes',
      },
      {
        id: 'p2',
        source: 'Reddit',
        headline: 'r/economics: Is free-market language losing its grip online?',
        excerpt: 'A long thread on why younger audiences split harder on markets than older generations did.',
        meta: '2.3k comments',
      },
      {
        id: 'p3',
        source: 'News',
        headline: 'The return of ideological economics in internet culture',
        excerpt: 'An article about why debates over labor, ownership, and mobility feel newly personal.',
        meta: '11 min read',
      },
    ],
  },
  {
    id: 'socrates-vs-altman',
    category: 'AI',
    title: 'Will AI make humans wiser or just more capable?',
    hook: 'Socrates vs Sam Altman',
    audience: '52.7k queued up',
    leftPerson: {
      name: 'Socrates',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Socrates_Louvre.jpg/330px-Socrates_Louvre.jpg',
      descriptor: 'questioning mind',
    },
    rightPerson: {
      name: 'Sam Altman',
      avatarUrl:
        'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Sam_Altman_TechCrunch_SF_2019_Day_2_Oct_3_%28cropped_3%29.jpg/330px-Sam_Altman_TechCrunch_SF_2019_Day_2_Oct_3_%28cropped_3%29.jpg',
      descriptor: 'builder of frontier AI',
    },
    likes: 31800,
    replies: 8800,
    reposts: 2600,
    transcript: [
      {
        speaker: 'Host',
        role: 'Opening',
        text: 'This debate is pure tension: if AI gives humanity extraordinary capability, does that also mean it gives humanity better judgment?',
      },
      {
        speaker: 'Socrates',
        role: 'Opening take',
        text: 'A tool that extends power without examining the soul may increase action while diminishing wisdom. Knowledge is not the same thing as understanding how one ought to live.',
      },
      {
        speaker: 'Sam Altman',
        role: 'Response',
        text: 'That is fair, but capability matters. Better tools can expand science, health, education, and economic access. Refusing to build them does not produce wisdom either.',
      },
      {
        speaker: 'Socrates',
        role: 'Counter',
        text: 'I do not argue for refusal. I argue for proportion. The city should not admire invention so much that it forgets to question the character of the inventors and the desires of the users.',
      },
      {
        speaker: 'Sam Altman',
        role: 'Close',
        text: 'Then perhaps the task is not choosing between wisdom and technology, but building institutions that force them to mature together.',
      },
    ],
    related: [
      {
        id: 'a1',
        source: 'X',
        headline: '“AI is making everyone faster. The question is whether it is making anyone deeper.”',
        excerpt: 'A philosophy thread that keeps getting reposted every time a new model launches.',
        meta: '31.7k likes',
      },
      {
        id: 'a2',
        source: 'Reddit',
        headline: 'r/artificial: Are we optimizing intelligence or judgment?',
        excerpt: 'Researchers, founders, and skeptics collide in a thread that refuses to stay technical.',
        meta: '3.1k comments',
      },
      {
        id: 'a3',
        source: 'News',
        headline: 'Why the AI argument is shifting from capability to wisdom',
        excerpt: 'A reported piece on how public concern is moving from what models can do to what societies can absorb.',
        meta: '8 min read',
      },
    ],
  },
]

const initialComments: Record<string, Comment[]> = {
  'nietzsche-vs-peterson': [
    {
      id: 'c1',
      author: 'Maya Chen',
      handle: '@mayareads',
      text: 'Nietzsche is brutal here, but Peterson lands the more livable argument. Most people need structure before they can do anything creative with freedom.',
      likes: 182,
    },
    {
      id: 'c2',
      author: 'Leo Grant',
      handle: '@leoonthefeed',
      text: 'This is exactly the kind of matchup I want from this app. It feels like two completely different definitions of meaning crashing into each other.',
      likes: 96,
    },
  ],
  'jobs-vs-musk': [
    {
      id: 'c3',
      author: 'Nina Park',
      handle: '@nina.builds',
      text: 'Jobs is right about taste, but Musk is right about ambition. The best products probably come from teams that can do both.',
      likes: 244,
    },
  ],
  'marx-vs-friedman': [
    {
      id: 'c4',
      author: 'Omar Lewis',
      handle: '@omarwrites',
      text: 'This one feels weirdly current. You can hear the whole internet arguing through them.',
      likes: 133,
    },
  ],
  'socrates-vs-altman': [
    {
      id: 'c5',
      author: 'Tara Singh',
      handle: '@tara_thinks',
      text: 'Socrates asking whether capability and wisdom can scale together is the best framing of AI I have seen in weeks.',
      likes: 301,
    },
  ],
}

const rankings: RankingEntry[] = [
  {
    name: 'Sam Altman',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Sam_Altman_TechCrunch_SF_2019_Day_2_Oct_3_%28cropped_3%29.jpg/330px-Sam_Altman_TechCrunch_SF_2019_Day_2_Oct_3_%28cropped_3%29.jpg',
    wins: 18,
    total: 24,
  },
  {
    name: 'Elon Musk',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/Elon_Musk_-_54820081119_%28cropped%29.jpg/330px-Elon_Musk_-_54820081119_%28cropped%29.jpg',
    wins: 16,
    total: 23,
  },
  {
    name: 'Jordan Peterson',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Jordan_Peterson_in_2018_%283x4_cropped%29.jpg/330px-Jordan_Peterson_in_2018_%283x4_cropped%29.jpg',
    wins: 14,
    total: 21,
  },
  {
    name: 'Milton Friedman',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/82/Portrait_of_Milton_Friedman_%284x5_cropped%29.jpg/330px-Portrait_of_Milton_Friedman_%284x5_cropped%29.jpg',
    wins: 13,
    total: 19,
  },
  {
    name: 'Friedrich Nietzsche',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Nietzsche187a.jpg/330px-Nietzsche187a.jpg',
    wins: 12,
    total: 20,
  },
  {
    name: 'Karl Marx',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Karl_Marx_001.jpg/330px-Karl_Marx_001.jpg',
    wins: 11,
    total: 18,
  },
  {
    name: 'Steve Jobs',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dc/Steve_Jobs_Headshot_2010-CROP_%28cropped_2%29.jpg/330px-Steve_Jobs_Headshot_2010-CROP_%28cropped_2%29.jpg',
    wins: 10,
    total: 17,
  },
  {
    name: 'Socrates',
    avatarUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Socrates_Louvre.jpg/330px-Socrates_Louvre.jpg',
    wins: 9,
    total: 16,
  },
]

function formatCount(value: number) {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }

  return `${value}`
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('trending')
  const [activeDebateId, setActiveDebateId] = useState(debates[0].id)
  const [selectedDebateId, setSelectedDebateId] = useState<string | null>(null)
  const [likedDebates, setLikedDebates] = useState<Record<string, boolean>>({})
  const [commentsByDebate, setCommentsByDebate] = useState(initialComments)
  const [draftComment, setDraftComment] = useState('')

  const activeDebate = useMemo(
    () => debates.find((debate) => debate.id === activeDebateId) ?? debates[0],
    [activeDebateId],
  )

  const selectedDebate = useMemo(
    () =>
      debates.find((debate) => debate.id === selectedDebateId) ?? activeDebate,
    [activeDebate, selectedDebateId],
  )

  const arenaDebate = useMemo(
    () => debates.find((debate) => debate.id === 'socrates-vs-altman') ?? debates[0],
    [],
  )

  const toggleLike = (debateId: string) => {
    setLikedDebates((current) => ({
      ...current,
      [debateId]: !current[debateId],
    }))
  }

  const bottomNav = (
    <nav className="bottom-nav" aria-label="Primary">
      <button
        type="button"
        className={`nav-item${activeTab === 'arena' ? ' active' : ''}`}
        onClick={() => {
          setActiveTab('arena')
          setSelectedDebateId(null)
        }}
      >
        <span>Arena</span>
      </button>
      <button
        type="button"
        className={`nav-item${activeTab === 'trending' ? ' active' : ''}`}
        onClick={() => {
          setActiveTab('trending')
          setSelectedDebateId(null)
        }}
      >
        <span>Trending</span>
      </button>
      <button
        type="button"
        className={`nav-item${activeTab === 'rankings' ? ' active' : ''}`}
        onClick={() => {
          setActiveTab('rankings')
          setSelectedDebateId(null)
        }}
      >
        <span>Rankings</span>
      </button>
      <button
        type="button"
        className={`nav-item${activeTab === 'settings' ? ' active' : ''}`}
        onClick={() => {
          setActiveTab('settings')
          setSelectedDebateId(null)
        }}
      >
        <span>Settings</span>
      </button>
    </nav>
  )

  if (selectedDebateId) {
    const isLiked = Boolean(likedDebates[selectedDebate.id])
    const likeCount = selectedDebate.likes + (isLiked ? 1 : 0)
    const comments = commentsByDebate[selectedDebate.id] ?? []

    const handleCommentSubmit = () => {
      const trimmed = draftComment.trim()

      if (!trimmed) {
        return
      }

      setCommentsByDebate((current) => ({
        ...current,
        [selectedDebate.id]: [
          {
            id: `comment-${Date.now()}`,
            author: 'You',
            handle: '@you',
            text: trimmed,
            likes: 0,
          },
          ...(current[selectedDebate.id] ?? []),
        ],
      }))
      setDraftComment('')
    }

    return (
      <main className="mobile-app">
        <header className="topbar">
          <button type="button" className="back-button" onClick={() => setSelectedDebateId(null)}>
            Back
          </button>
          <strong>{selectedDebate.category}</strong>
          <span className="topbar-pill">{selectedDebate.audience}</span>
        </header>

        <section className="detail-hero">
          <div className="hero-chip-row">
            <span className="hero-chip">{selectedDebate.category}</span>
            <span className="hero-chip">{selectedDebate.audience}</span>
          </div>
          <h1>{selectedDebate.title}</h1>
          <p>{selectedDebate.hook}</p>

          <div className="detail-actions">
            <button
              type="button"
              className={`like-button${isLiked ? ' liked' : ''}`}
              onClick={() => toggleLike(selectedDebate.id)}
            >
              {isLiked ? 'Liked' : 'Like'} {formatCount(likeCount)}
            </button>
            <span className="detail-meta">{formatCount(selectedDebate.replies)} replies</span>
            <span className="detail-meta">{formatCount(selectedDebate.reposts)} reposts</span>
          </div>

          <div className="thread-intro">
            <div className="thread-hero-person">
              <Avatar
                className="thread-person-image"
                src={selectedDebate.leftPerson.avatarUrl}
                alt={selectedDebate.leftPerson.name}
                fallback={selectedDebate.leftPerson.name.charAt(0)}
              />
              <div>
                <strong>{selectedDebate.leftPerson.name}</strong>
                <span>{selectedDebate.leftPerson.descriptor}</span>
              </div>
            </div>
            <div className="thread-hero-person">
              <Avatar
                className="thread-person-image"
                src={selectedDebate.rightPerson.avatarUrl}
                alt={selectedDebate.rightPerson.name}
                fallback={selectedDebate.rightPerson.name.charAt(0)}
              />
              <div>
                <strong>{selectedDebate.rightPerson.name}</strong>
                <span>{selectedDebate.rightPerson.descriptor}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="thread-shell detail-thread">
          <div className="section-heading">
            <div>
              <p className="section-label">Transcript</p>
              <h2>{selectedDebate.hook}</h2>
            </div>
            <span className="section-chip dark">
              {selectedDebate.transcript.length} moments
            </span>
          </div>

          <div className="thread-list">
            {selectedDebate.transcript.map((line, index) => {
              const speakerAvatar =
                line.speaker === selectedDebate.leftPerson.name
                  ? selectedDebate.leftPerson.avatarUrl
                  : line.speaker === selectedDebate.rightPerson.name
                    ? selectedDebate.rightPerson.avatarUrl
                    : ''

              return (
                <article key={`${line.speaker}-${index}`} className="thread-post">
                  <div className="thread-author">
                    {speakerAvatar ? (
                      <Avatar
                        className="thread-avatar"
                        src={speakerAvatar}
                        alt={line.speaker}
                        fallback={line.speaker.charAt(0)}
                      />
                    ) : (
                      <div className="thread-avatar-fallback">{line.speaker.charAt(0)}</div>
                    )}
                    <div>
                      <strong>{line.speaker}</strong>
                      <span>{line.role}</span>
                    </div>
                  </div>
                  <p>{line.text}</p>
                </article>
              )
            })}
          </div>
        </section>

        <section className="related-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Around the debate</p>
              <h2>What the internet is saying</h2>
            </div>
          </div>

          <div className="related-list">
            {selectedDebate.related.map((item) => (
              <article key={item.id} className="related-card">
                <div className="related-top">
                  <span className={`source-pill source-${item.source.toLowerCase()}`}>{item.source}</span>
                  <span className="related-meta">{item.meta}</span>
                </div>
                <h3>{item.headline}</h3>
                <p>{item.excerpt}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="comments-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Discussion</p>
              <h2>What people think</h2>
            </div>
            <span className="section-chip">{comments.length} comments</span>
          </div>

          <div className="comment-composer">
            <textarea
              value={draftComment}
              onChange={(event) => setDraftComment(event.target.value)}
              placeholder="Add your take on this debate..."
              rows={3}
            />
            <button type="button" className="comment-button" onClick={handleCommentSubmit}>
              Post comment
            </button>
          </div>

          <div className="comment-list">
            {comments.map((comment) => (
              <article key={comment.id} className="comment-card">
                <div className="comment-top">
                  <div className="comment-author">
                    <div className="comment-avatar">{comment.author.charAt(0)}</div>
                    <div>
                      <strong>{comment.author}</strong>
                      <span>{comment.handle}</span>
                    </div>
                  </div>
                  <span className="comment-likes">{formatCount(comment.likes)} likes</span>
                </div>
                <p>{comment.text}</p>
              </article>
            ))}
          </div>
        </section>
        {bottomNav}
      </main>
    )
  }

  if (activeTab === 'arena') {
    const arenaLiked = Boolean(likedDebates[arenaDebate.id])
    const arenaLikes = arenaDebate.likes + (arenaLiked ? 1 : 0)

    return (
      <main className="mobile-app">
        <header className="topbar">
          <div>
            <span className="brand-mark">X</span>
            <strong>AI Debates</strong>
          </div>
          <span className="topbar-pill">Picked for you</span>
        </header>

        <section className="hero-card">
          <div className="hero-chip-row">
            <span className="hero-chip">Arena</span>
            <span className="hero-chip">Based on your interests</span>
          </div>
          <h1>{arenaDebate.title}</h1>
          <p>
            A debate selected for you from the topics you keep spending time with:
            AI, power, and how technology changes judgment.
          </p>
        </section>

        <section className="feed-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Today in arena</p>
              <h2>{arenaDebate.hook}</h2>
            </div>
            <span className="section-chip">{arenaDebate.audience}</span>
          </div>

          <article className="debate-card active">
            <button
              type="button"
              className="debate-card-main"
              onClick={() => {
                setActiveDebateId(arenaDebate.id)
                setSelectedDebateId(arenaDebate.id)
              }}
            >
              <div className="debate-card-top">
                <span className="category-pill">{arenaDebate.category}</span>
                <span className="audience-pill">For you</span>
              </div>
              <h3>{arenaDebate.title}</h3>
              <p>{arenaDebate.hook}</p>
              <div className="faceoff-row">
                <div className="person-preview">
                  <Avatar
                    className="person-image"
                    src={arenaDebate.leftPerson.avatarUrl}
                    alt={arenaDebate.leftPerson.name}
                    fallback={arenaDebate.leftPerson.name.charAt(0)}
                  />
                  <div>
                    <strong>{arenaDebate.leftPerson.name}</strong>
                    <span>{arenaDebate.leftPerson.descriptor}</span>
                  </div>
                </div>
                <span className="versus-pill">vs</span>
                <div className="person-preview align-right">
                  <Avatar
                    className="person-image"
                    src={arenaDebate.rightPerson.avatarUrl}
                    alt={arenaDebate.rightPerson.name}
                    fallback={arenaDebate.rightPerson.name.charAt(0)}
                  />
                  <div>
                    <strong>{arenaDebate.rightPerson.name}</strong>
                    <span>{arenaDebate.rightPerson.descriptor}</span>
                  </div>
                </div>
              </div>
            </button>

            <div className="feed-card-actions">
              <button
                type="button"
                className={`like-button${arenaLiked ? ' liked' : ''}`}
                onClick={() => toggleLike(arenaDebate.id)}
              >
                {arenaLiked ? 'Liked' : 'Like'} {formatCount(arenaLikes)}
              </button>
              <span>{formatCount(arenaDebate.replies)} replies</span>
              <span>{formatCount(arenaDebate.reposts)} reposts</span>
            </div>
          </article>
        </section>
        {bottomNav}
      </main>
    )
  }

  if (activeTab === 'rankings') {
    return (
      <main className="mobile-app">
        <header className="topbar">
          <div>
            <span className="brand-mark">X</span>
            <strong>AI Debates</strong>
          </div>
          <span className="topbar-pill">All-time leaderboard</span>
        </header>

        <section className="feed-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Rankings</p>
              <h2>The most successful debaters</h2>
            </div>
          </div>

          <div className="ranking-list">
            {rankings.map((entry, index) => (
              <article key={entry.name} className="ranking-card">
                <div className="ranking-left">
                  <span className="ranking-rank">#{index + 1}</span>
                  <Avatar
                    className="ranking-avatar"
                    src={entry.avatarUrl}
                    alt={entry.name}
                    fallback={entry.name.charAt(0)}
                  />
                  <div>
                    <strong>{entry.name}</strong>
                    <span>{Math.round((entry.wins / entry.total) * 100)}% win rate</span>
                  </div>
                </div>
                <div className="ranking-right">
                  <strong>{entry.wins}</strong>
                  <span>wins</span>
                </div>
              </article>
            ))}
          </div>
        </section>
        {bottomNav}
      </main>
    )
  }

  if (activeTab === 'settings') {
    return (
      <main className="mobile-app">
        <header className="topbar">
          <div>
            <span className="brand-mark">X</span>
            <strong>AI Debates</strong>
          </div>
          <span className="topbar-pill">Your account</span>
        </header>

        <section className="feed-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Settings</p>
              <h2>Tune your experience</h2>
            </div>
          </div>

          <div className="settings-list">
            <article className="setting-card">
              <div>
                <strong>Personalized arena</strong>
                <span>Use your reading and likes to choose debates for Arena.</span>
              </div>
              <span className="setting-state">On</span>
            </article>
            <article className="setting-card">
              <div>
                <strong>Show related conversation</strong>
                <span>Include posts, threads, and articles around each debate.</span>
              </div>
              <span className="setting-state">On</span>
            </article>
            <article className="setting-card">
              <div>
                <strong>Comment notifications</strong>
                <span>Get updates when someone replies to your take.</span>
              </div>
              <span className="setting-state">On</span>
            </article>
          </div>
        </section>
        {bottomNav}
      </main>
    )
  }

  return (
    <main className="mobile-app">
      <header className="topbar">
        <div>
          <span className="brand-mark">X</span>
          <strong>AI Debates</strong>
        </div>
        <span className="topbar-pill">Debates worth your time</span>
      </header>

      <section className="hero-card">
        <div className="hero-chip-row">
          <span className="hero-chip">Past meets present</span>
          <span className="hero-chip">Unexpected matchups</span>
        </div>
        <h1>The debates history never gave us.</h1>
        <p>
          Famous minds, impossible matchups, and sharp conversations people
          actually want to spend time with.
        </p>
      </section>

      <section className="feed-shell">
        <div className="section-heading">
          <div>
            <p className="section-label">Trending debates</p>
            <h2>What people are listening to</h2>
          </div>
          <span className="section-chip">{debates.length} debates today</span>
        </div>

        <div className="feed-list">
          {debates.map((debate) => {
            const isActive = debate.id === activeDebate.id
            const isLiked = Boolean(likedDebates[debate.id])
            const likeCount = debate.likes + (isLiked ? 1 : 0)

            return (
              <article
                key={debate.id}
                className={`debate-card${isActive ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="debate-card-main"
                  onClick={() => {
                    setActiveDebateId(debate.id)
                    setSelectedDebateId(debate.id)
                  }}
                  aria-label={`Open debate: ${debate.hook}`}
                >
                  <div className="debate-card-top">
                    <span className="category-pill">{debate.category}</span>
                    <span className="audience-pill">{debate.audience}</span>
                  </div>

                  <h3>{debate.title}</h3>
                  <p>{debate.hook}</p>

                  <div className="faceoff-row">
                    <div className="person-preview">
                      <Avatar
                        className="person-image"
                        src={debate.leftPerson.avatarUrl}
                        alt={debate.leftPerson.name}
                        fallback={debate.leftPerson.name.charAt(0)}
                      />
                      <div>
                        <strong>{debate.leftPerson.name}</strong>
                        <span>{debate.leftPerson.descriptor}</span>
                      </div>
                    </div>

                    <span className="versus-pill">vs</span>

                    <div className="person-preview align-right">
                      <Avatar
                        className="person-image"
                        src={debate.rightPerson.avatarUrl}
                        alt={debate.rightPerson.name}
                        fallback={debate.rightPerson.name.charAt(0)}
                      />
                      <div>
                        <strong>{debate.rightPerson.name}</strong>
                        <span>{debate.rightPerson.descriptor}</span>
                      </div>
                    </div>
                  </div>
                </button>

                <div className="feed-card-actions">
                  <button
                    type="button"
                    className={`like-button${isLiked ? ' liked' : ''}`}
                    onClick={() => toggleLike(debate.id)}
                  >
                    {isLiked ? 'Liked' : 'Like'} {formatCount(likeCount)}
                  </button>
                  <span>{formatCount(debate.replies)} replies</span>
                  <span>{formatCount(debate.reposts)} reposts</span>
                </div>
              </article>
            )
          })}
        </div>
      </section>
      {bottomNav}
    </main>
  )
}

export default App
