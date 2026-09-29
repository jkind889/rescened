import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import 'bootstrap/dist/css/bootstrap.min.css';
import "./App.css";
import SearchResults from "./Pages/SearchResults";
import AlbumDetail from "./Components/AlbumDetail";
import ViewReviews from "./Pages/ViewReviews";
import ReviewDispatches from "./Pages/ReviewDispatches";
import PopularAlbums from "./Pages/PopularAlbums";
import FrontPage from "./Pages/FrontPage";
import Layout from "./Layout";
import Account from "./Pages/Account";
import EditProfile from "./Pages/EditProfile";
import LastfmCallback from "./Pages/LastfmCallback";
import AlbumMappings from "./Pages/AlbumMappings";
import ProfileNetwork from "./Pages/ProfileNetwork";
import Boards from "./Pages/Boards";
import BoardDetail from "./Pages/BoardDetail";
import Notifications from "./Pages/Notifications";
import PatchNotes from "./Pages/PatchNotes";
import ProtectedRoute from "./Components/ProtectedRoute";

const Suggestions = lazy(() => import("./Pages/Suggestions"));
const SuggestionEditor = lazy(() => import("./Pages/SuggestionEditor"));
const ApprovedSuggestions = lazy(() => import("./Pages/ApprovedSuggestions"));
const ModerationSuggestions = lazy(() => import("./Pages/ModerationSuggestions"));
const AlbumBaselines = lazy(() => import("./Pages/AlbumBaselines"));

export function App() {
   return (
    <BrowserRouter>
      <div className="app-shell">
        <Suspense fallback={<div className="community-loading" role="status">Loading community workspace…</div>}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<FrontPage />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/boards" element={<Boards />} />
            <Route path="/boards/:boardId" element={<BoardDetail />} />
            <Route
              path="/collection"
              element={<Navigate to="/account" state={{ activeTab: "saved" }} replace />}
            />
            <Route path="/album/:albumId" element={<AlbumDetail />} />
            <Route path="/album/:albumId/reviews" element={<AlbumDetail />} />
            <Route path="/viewreviews" element={
            <ProtectedRoute>
              <ViewReviews />
            </ProtectedRoute>} />
            <Route path="/review-dispatches" element={<ReviewDispatches />} />
            <Route path="/popular-albums" element={<PopularAlbums />} />
            <Route path="/community/approved" element={<ApprovedSuggestions />} />
            <Route path="/patch-notes" element={<PatchNotes />} />
            <Route path="/account" element={<Account />} />
            <Route path="/account/network" element={<ProfileNetwork />} />
            <Route path="/notifications" element={
              <ProtectedRoute>
                <Notifications />
              </ProtectedRoute>} />
            <Route path="/suggestions" element={
              <ProtectedRoute>
                <Suggestions />
              </ProtectedRoute>} />
            <Route path="/suggestions/new" element={
              <ProtectedRoute>
                <SuggestionEditor />
              </ProtectedRoute>} />
            <Route path="/suggestions/corrections/:albumId" element={
              <ProtectedRoute>
                <SuggestionEditor mode="correction" />
              </ProtectedRoute>} />
            <Route path="/suggestions/:submissionId/revise" element={
              <ProtectedRoute>
                <SuggestionEditor mode="revise" />
              </ProtectedRoute>} />
            <Route path="/suggestions/:submissionId" element={
              <ProtectedRoute>
                <Suggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/album-suggestions" element={
              <ProtectedRoute>
                <ModerationSuggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/album-suggestions/:submissionId" element={
              <ProtectedRoute>
                <ModerationSuggestions />
              </ProtectedRoute>} />
            <Route path="/moderation/album-mappings" element={
              <ProtectedRoute>
                <AlbumMappings />
              </ProtectedRoute>} />
            <Route path="/moderation/album-mappings/:caseId" element={
              <ProtectedRoute>
                <AlbumMappings />
              </ProtectedRoute>} />
            <Route path="/moderation/album-baselines" element={
              <ProtectedRoute>
                <AlbumBaselines />
              </ProtectedRoute>} />
            <Route path="/moderation/album-baselines/:albumId" element={
              <ProtectedRoute>
                <AlbumBaselines />
              </ProtectedRoute>} />
            <Route path="/profile/:userId/reviews" element={<ViewReviews />} />
            <Route path="/profile/:userId/network" element={<ProfileNetwork />} />
            <Route path="/profile/:userId/boards/:boardId" element={<BoardDetail />} />
            <Route path="/profile/:userId" element={<Account />} />
            <Route path="/account/edit" element={
              <ProtectedRoute>
                <EditProfile />
              </ProtectedRoute>} />
            <Route path="/account/lastfm/callback" element={<LastfmCallback />} />
          </Route>
        </Routes>
        </Suspense>
      </div>
    </BrowserRouter>
  );


}

export default App
