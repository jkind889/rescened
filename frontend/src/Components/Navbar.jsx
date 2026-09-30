import { API_BASE_URL } from "../config/api";
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import SearchBar from './Searchbar'
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
} from '@clerk/react'

function SiteNavLink({ to, current, children })
{
    return (
        <Link
            to={to}
            className={`nav-link${current ? " nav-link-current" : ""}`}
            aria-current={current ? "page" : undefined}
        >
            {children}
        </Link>
    )
}

function Navbar()
{
    const { getToken, isLoaded, isSignedIn } = useAuth()
    const location = useLocation()
    const [unreadCount, setUnreadCount] = useState(0)
    const [isModerator, setIsModerator] = useState(false)
    const isCurrent = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`)
    const [theme, setTheme] = useState(() => localStorage.getItem("rescened-theme") || "dark")

    useEffect(() => {
        document.documentElement.dataset.theme = theme
        localStorage.setItem("rescened-theme", theme)
    }, [theme])

    useEffect(() => {
        let isCurrent = true

        async function fetchUnreadCount() {
            if (!isLoaded || !isSignedIn) {
                setUnreadCount(0)
                return
            }

            if (location.pathname === "/notifications") {
                setUnreadCount(0)
                return
            }

            try {
                const token = await getToken()
                const response = await fetch(`${API_BASE_URL}/notifications/unread-count`, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })

                if (!response.ok) {
                    throw new Error("Failed to fetch unread notifications")
                }

                const data = await response.json()

                if (isCurrent) {
                    setUnreadCount(Number(data.unreadCount) || 0)
                }
            } catch (error) {
                console.error(error)

                if (isCurrent) {
                    setUnreadCount(0)
                }
            }
        }

        fetchUnreadCount()

        return () => {
            isCurrent = false
        }
    }, [getToken, isLoaded, isSignedIn, location.pathname])

    // Display hint only: the moderation API enforces moderator access itself.
    useEffect(() => {
        const controller = new AbortController()

        async function fetchModeratorAccess() {
            if (!isLoaded || !isSignedIn) {
                setIsModerator(false)
                return
            }

            try {
                const token = await getToken()
                const response = await fetch(`${API_BASE_URL}/moderation/album-suggestions/access`, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: controller.signal,
                })
                const data = response.ok ? await response.json() : {}
                setIsModerator(data.moderator === true)
            } catch (error) {
                if (error.name !== "AbortError") {
                    setIsModerator(false)
                }
            }
        }

        fetchModeratorAccess()

        return () => controller.abort()
    }, [getToken, isLoaded, isSignedIn])

    return (
        <>
            <header className="site-header">
                <nav className="site-navbar" aria-label="Main">
                    <div className="site-navbar-inner">
                        <Link to="/" className="navbar-brand">rescened</Link>
                        <div className="site-navbar-center">
                            <ul className="site-nav-links">
                                <li>
                                    <SiteNavLink to="/boards" current={isCurrent("/boards")}>Boards</SiteNavLink>
                                </li>
                                <li>
                                    <SiteNavLink to="/community" current={location.pathname === "/community"}>Community</SiteNavLink>
                                </li>
                                <li>
                                    <SiteNavLink to="/community/approved" current={isCurrent("/community/approved")}>Approved</SiteNavLink>
                                </li>
                                <li>
                                    <SiteNavLink to="/patch-notes" current={isCurrent("/patch-notes")}>Patch notes</SiteNavLink>
                                </li>
                                <Show when="signed-in">
                                    <li>
                                        <SiteNavLink
                                            to="/suggestions"
                                            current={isCurrent("/suggestions")}
                                        >
                                            Suggestions
                                        </SiteNavLink>
                                    </li>
                                </Show>
                            </ul>
                            <div className="site-navbar-search">
                                <SearchBar />
                            </div>
                            <Show when="signed-in">
                                <Link
                                    to="/notifications"
                                    className={`nav-link nav-notification-link${isCurrent("/notifications") ? " nav-link-current" : ""}`}
                                    aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
                                >
                                    Notifications
                                    {unreadCount > 0 && (
                                        <span className="nav-notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
                                    )}
                                </Link>
                                {isModerator && (
                                    <SiteNavLink to="/moderation/album-suggestions" current={isCurrent("/moderation")}>
                                        Moderation
                                    </SiteNavLink>
                                )}
                            </Show>
                        </div>
                        <div className="site-navbar-actions">
                            <button
                                type="button"
                                className="theme-toggle"
                                onClick={() => setTheme((currentTheme) => currentTheme === "dark" ? "light" : "dark")}
                                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                            >
                                {theme === "dark" ? "Light" : "Dark"}
                            </button>
                            <Show when="signed-out">
                                <SignInButton mode="modal">
                                    <button type="button" className="nav-auth-button nav-auth-button-secondary">
                                        Sign in
                                    </button>
                                </SignInButton>
                                <SignUpButton mode="modal">
                                    <button type="button" className="nav-auth-button">
                                        Sign up
                                    </button>
                                </SignUpButton>
                            </Show>

                            <Show when="signed-in">
                                <SiteNavLink to="/account" current={isCurrent("/account")}>
                                    Account
                                </SiteNavLink>
                                <UserButton afterSignOutUrl="/" />
                            </Show>
                        </div>
                    </div>
                </nav>
            </header>
        </>
    )

}

export default Navbar
