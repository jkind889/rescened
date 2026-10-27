import { API_BASE_URL } from "../config/api";
import {useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage } from "../utils/apiErrors";
import Cover from "./Cover";

const MIN_SUGGESTION_QUERY_LENGTH = 2;
const SUGGESTION_LIMIT = 5;

export function SearchBar({ placeholder = "Search" })
{
    const [input, setInput] = useState("")
    const [suggestions, setSuggestions] = useState([]);
    const [suggestionError, setSuggestionError] = useState("");
    const [showDropdown, setShowDropdown] = useState(false);
    const navigate = useNavigate()


  
    useEffect(() => {
       const query = input.trim();

       if (query.length < MIN_SUGGESTION_QUERY_LENGTH) {
          setSuggestions([]);
          setSuggestionError("");
          setShowDropdown(false);
          return undefined;
       }

       const controller = new AbortController();
       const timeoutId = setTimeout(async () => {

        try {
          const searchParams = new URLSearchParams({
            q: query,
            limit: String(SUGGESTION_LIMIT),
          });
          const response = await fetch(
            `${API_BASE_URL}/search/search?${searchParams.toString()}`,
            { signal: controller.signal },
          );

          if (!response.ok) {
            throw new Error(await getApiErrorMessage(response, "Could not load search suggestions."));
          }

          const data = await response.json();
          const results = Array.isArray(data) ? data : data?.results;
          setSuggestions(Array.isArray(results) ? results : []);
          setSuggestionError("");
        } catch (error) {
          if (error.name === "AbortError") {
            return;
          }

          setSuggestions([]);
          setSuggestionError(error.message || "Could not load search suggestions.");
        }
          }, 200); // Wait briefly so fast typing does not trigger a request per keystroke.

          return () => {
            clearTimeout(timeoutId);
            controller.abort();
          }; // Clear the pending request if the input changes before it completes.
        }, [input]);

        useEffect(() => {
          const handleClick = () => setShowDropdown(false);

          document.addEventListener("click", handleClick);
          return () => document.removeEventListener("click", handleClick);
        }, []);


    const handleSubmit = (e) => 
    {
        e.preventDefault();
        // Navigate to the search results page with the query as a URL parameter

        if (!input) return;
        
        const history = JSON.parse(localStorage.getItem("history")) || [];

        const updated = [input, ...history.filter(item => item !== input)].slice(0, 5);

        const limited = updated.slice(0, 5);

        localStorage.setItem("history", JSON.stringify(limited));

        navigate(`/search?q=${encodeURIComponent(input)}`)
    };




    return (
    <form className="search-form" onSubmit={handleSubmit}>
    
      <input
        className="search-input"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setSuggestionError("");
          setShowDropdown(true);
        }}
        onFocus={() => setShowDropdown(true)}
        placeholder={placeholder}
      />
      <button className="search-submit" type="submit" aria-label="Search albums">Search</button>
    <div className="search-dropdown-wrap" onClick={(e) => e.stopPropagation()}>
      {showDropdown && suggestionError && (
        <p className="search-dropdown-message" role="alert">{suggestionError}</p>
      )}
      {showDropdown && !suggestionError && suggestions.length > 0 && (
        <ul className="suggestions-dropdown">
          {suggestions.map((suggestion) => (
            <li key={suggestion.albumId} onClick={() => { navigate(`/album/${suggestion.albumId}`); setShowDropdown(false); }}>
             <Cover src={suggestion.cover} className="suggestion-cover" alt={suggestion.title} size={32} />
             {suggestion.title} - {suggestion.artistDisplayName}
            </li>
          ))}
        </ul>
      )}
      </div>






    </form>
  );


}



export default SearchBar;
