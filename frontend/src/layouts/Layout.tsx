import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { FiShare2, FiClock, FiSend, FiDownload, FiHome } from 'react-icons/fi';
import { useRoomStore } from '../store/roomStore';

const Layout: React.FC = () => {
  const { pathname } = useLocation();
  const isConnected  = useRoomStore((s) => s.isSignalingConnected);

  return (
    <div className="min-h-screen flex flex-col text-slate-100 font-sans relative overflow-hidden bg-slate-950">
      {/* Ambient background glows */}
      <div className="fixed top-[-15%] left-[-10%] w-[45%] h-[45%] rounded-full bg-blue-600/15 blur-[130px] pointer-events-none" />
      <div className="fixed bottom-[-15%] right-[-10%] w-[45%] h-[45%] rounded-full bg-purple-600/15 blur-[130px] pointer-events-none" />

      {/* Navbar — minimal */}
      <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800/60">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="p-1.5 bg-blue-500 rounded-lg group-hover:bg-blue-400 transition-colors">
              <FiShare2 className="text-white text-lg" />
            </div>
            <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              ChikkoShare
            </span>
          </Link>

          <div className="flex items-center gap-4">
            {/* Desktop Nav Links */}
            <div className="hidden sm:flex items-center gap-6 mr-2 pr-6 border-r border-slate-800">
              <Link to="/send" className={`flex items-center gap-2 text-sm font-medium transition-colors ${pathname === '/send' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}>
                <FiSend /> Send
              </Link>
              <Link to="/receive" className={`flex items-center gap-2 text-sm font-medium transition-colors ${pathname === '/receive' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}>
                <FiDownload /> Receive
              </Link>
              <Link to="/dashboard" className={`flex items-center gap-2 text-sm font-medium transition-colors ${pathname === '/dashboard' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'}`}>
                <FiClock /> History
              </Link>
            </div>

            {/* Connection dot (Visible everywhere) */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-slate-600'} ${isConnected ? 'shadow-[0_0_6px_#34d399]' : ''}`} />
              <span className={isConnected ? 'text-emerald-400' : 'text-slate-500'}>
                {isConnected ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 pt-8 pb-24 sm:pb-8 flex flex-col relative z-10">
        <Outlet />
      </main>

      <footer className="hidden sm:block py-4 text-center text-slate-600 text-xs border-t border-slate-800/40">
        ChikkoShare &copy; {new Date().getFullYear()} — Fast. Secure. No limits.
      </footer>

      {/* Mobile Bottom Navigation */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-slate-900/95 backdrop-blur-xl border-t border-slate-800/60 pb-safe">
        <div className="flex items-center justify-around h-16 px-2">
          <Link to="/" className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${pathname === '/' ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <FiHome className="text-xl" />
            <span className="text-[10px] font-medium">Home</span>
          </Link>
          <Link to="/send" className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${pathname === '/send' ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <FiSend className="text-xl" />
            <span className="text-[10px] font-medium">Send</span>
          </Link>
          <Link to="/receive" className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${pathname === '/receive' ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <FiDownload className="text-xl" />
            <span className="text-[10px] font-medium">Receive</span>
          </Link>
          <Link to="/dashboard" className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${pathname === '/dashboard' ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
            <FiClock className="text-xl" />
            <span className="text-[10px] font-medium">History</span>
          </Link>
        </div>
      </nav>
    </div>
  );
};

export default Layout;
