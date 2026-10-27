import { Suspense } from "react"
import Navbar from "./Components/Navbar"
import { Outlet } from 'react-router-dom'
import LoadingState from "./Components/Loading/LoadingState"

export function Layout()
{
    return (
        <>
        <Navbar/>
        <main>
            {/* Route chunks load lazily; the navbar stays mounted while they do. */}
            <Suspense fallback={<LoadingState message="Loading…" />}>
                <Outlet/>
            </Suspense>
        </main>
        </>
    )
}

export default Layout
