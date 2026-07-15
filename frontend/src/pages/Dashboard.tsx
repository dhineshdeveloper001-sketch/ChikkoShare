import React from 'react';
import { motion } from 'framer-motion';
import { FiClock, FiTrash2 } from 'react-icons/fi';
import { useTransferStore } from '../store/transferStore';

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024, units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
};

const Dashboard: React.FC = () => {
  const history      = useTransferStore((s) => s.history);
  const clearHistory = useTransferStore((s) => s.clearHistory);

  return (
    <motion.div
      className="w-full max-w-3xl mx-auto"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <FiClock className="text-blue-400" /> Transfer History
        </h2>
        {history.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1.5 text-red-400 hover:text-red-300 text-sm bg-red-400/10 hover:bg-red-400/20 px-3 py-1.5 rounded-lg transition-colors"
          >
            <FiTrash2 /> Clear
          </button>
        )}
      </div>

      <div className="bg-slate-900/50 rounded-2xl border border-slate-800/60 overflow-hidden">
        {history.length === 0 ? (
          <div className="py-16 text-center text-slate-500">
            <FiClock className="text-4xl mx-auto mb-3 opacity-40" />
            <p>No transfer history yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {history.map((item) => (
              <div key={item.id} className="flex items-center gap-4 px-5 py-4 hover:bg-slate-800/20 transition-colors">
                {/* Status dot */}
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  item.status === 'Completed' ? 'bg-emerald-400' :
                  item.status === 'Failed'    ? 'bg-red-400'     : 'bg-slate-500'
                }`} />

                {/* File info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-200 truncate">{item.filename}</p>
                  <p className="text-slate-500 text-xs">{formatSize(item.size)}</p>
                </div>

                {/* Mode badge */}
                <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
                  item.networkMode === 'local' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'
                }`}>
                  {item.networkMode === 'local' ? 'Local' : 'Cloud'}
                </span>

                {/* Status badge */}
                <span className={`text-xs px-2 py-0.5 rounded font-medium shrink-0 ${
                  item.status === 'Completed' ? 'bg-emerald-500/10 text-emerald-400' :
                  item.status === 'Failed'    ? 'bg-red-500/10 text-red-400'         : 'bg-slate-500/10 text-slate-400'
                }`}>
                  {item.status}
                </span>

                {/* Date */}
                <span className="text-slate-600 text-xs shrink-0 hidden sm:inline">
                  {new Date(item.date).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default Dashboard;
