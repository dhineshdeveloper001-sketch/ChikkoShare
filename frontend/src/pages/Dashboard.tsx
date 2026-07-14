import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FiClock, FiTrash2, FiSearch } from 'react-icons/fi';

interface TransferHistory {
  id: string;
  name: string;
  size: number;
  date: number;
  status: string;
  speed: number;
}

const Dashboard: React.FC = () => {
  const [history, setHistory] = useState<TransferHistory[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    // In a full implementation, we would use IndexedDB or localStorage to store history when transfers complete.
    // For now, load from local storage or show empty state.
    const stored = localStorage.getItem('chikko_history');
    if (stored) {
      setHistory(JSON.parse(stored));
    } else {
      // Mock data for UI demonstration
      setHistory([
        { id: '1', name: 'project_backup.zip', size: 1540000000, date: Date.now() - 3600000, status: 'Completed', speed: 95000000 },
        { id: '2', name: 'vacation_photos.rar', size: 850000000, date: Date.now() - 86400000, status: 'Completed', speed: 120000000 },
        { id: '3', name: 'demo_video.mp4', size: 250000000, date: Date.now() - 172800000, status: 'Failed', speed: 45000000 },
      ]);
    }
  }, []);

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredHistory = history.filter(item => item.name.toLowerCase().includes(search.toLowerCase()));

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('chikko_history');
  };

  return (
    <div className="flex flex-col items-center py-8">
      <motion.div 
        className="glass-panel w-full max-w-4xl p-8"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-3xl font-bold flex items-center gap-3">
            <FiClock className="text-blue-500" /> Transfer History
          </h2>
          <button 
            onClick={clearHistory}
            className="flex items-center gap-2 text-red-400 hover:text-red-300 transition-colors bg-red-400/10 hover:bg-red-400/20 px-4 py-2 rounded-lg text-sm font-medium"
          >
            <FiTrash2 /> Clear History
          </button>
        </div>

        <div className="mb-6 relative">
          <FiSearch className="absolute left-4 top-1/2 transform -translate-y-1/2 text-slate-500 text-lg" />
          <input 
            type="text" 
            placeholder="Search transfers..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-slate-900/50 border border-slate-700 rounded-xl pl-12 pr-4 py-3 text-white placeholder:text-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <div className="bg-slate-900/50 rounded-2xl border border-slate-700/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-800/50 text-slate-400 text-sm border-b border-slate-700/50">
                  <th className="p-4 font-medium">Filename</th>
                  <th className="p-4 font-medium">Size</th>
                  <th className="p-4 font-medium">Date</th>
                  <th className="p-4 font-medium">Speed</th>
                  <th className="p-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.length > 0 ? (
                  filteredHistory.map((item, i) => (
                    <tr key={item.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors last:border-0">
                      <td className="p-4 font-medium text-slate-200">{item.name}</td>
                      <td className="p-4 text-slate-400">{formatSize(item.size)}</td>
                      <td className="p-4 text-slate-400">{new Date(item.date).toLocaleDateString()}</td>
                      <td className="p-4 text-slate-400">{formatSize(item.speed)}/s</td>
                      <td className="p-4">
                        <span className={`px-2 py-1 rounded text-xs font-bold ${
                          item.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-400' :
                          item.status === 'Failed' ? 'bg-red-500/10 text-red-400' : 'bg-slate-500/10 text-slate-400'
                        }`}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500">
                      No transfers found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default Dashboard;
